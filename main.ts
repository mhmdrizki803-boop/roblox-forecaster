// roblox-up-and-coming-forecast-01 entry (Node 22, standard library only).
//
// Forecasts Roblox's Up-and-Coming chart place by place for the hours after the history ends.
// Reads /input/history.ndjson (reads of the chart) and /input/task.json, estimates a rank-transition
// matrix over the scored places plus a "near" state (ranks just below them, where climbers come
// from) and an "out" state, normalises it to one slot per step, propagates each game's place
// distribution from where the last read put it, and averages the per-slot distributions over the
// window. Writes /output/forecast.json: per place the probability each game holds it, the rest
// unnamed for the scorer to share over the chart.
//
// Outside the grader: MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Row { rank: number; universe_id: number; name?: string; playing?: number }
interface Snap { at?: string; up_and_coming?: Row[]; ok?: boolean }

const task = JSON.parse(readFileSync(join(INPUT_DIR, 'task.json'), 'utf8')) as {
  places?: number; output?: string; window?: { slots?: number; slot_minutes?: number };
};
const PLACES: number = task.places ?? 10;
const SLOTS: number = task.window?.slots ?? 72;
const SLOT_MIN: number = task.window?.slot_minutes ?? 60;
const OUTNAME: string = task.output ?? 'forecast.json';

function write(doc: unknown): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, OUTNAME), `${JSON.stringify(doc)}\n`);
}

/** Reads, oldest first: the chart's ids in place order and the time each was taken. */
const reads: Array<{ t: number; ids: number[] }> = [];
for (const line of readFileSync(join(INPUT_DIR, 'history.ndjson'), 'utf8').split('\n')) {
  if (line.trim() === '') continue;
  let s: Snap;
  try { s = JSON.parse(line) as Snap } catch { continue }
  const ua = s.up_and_coming;
  if (!ua || ua.length === 0) continue;
  const ids = [...ua].sort((a, b) => a.rank - b.rank).map((r) => r.universe_id);
  if (ids.length === 0) continue;
  reads.push({ t: s.at ? Date.parse(s.at) : 0, ids });
}
if (reads.length === 0) {
  // No readable read: an empty probabilities list is a valid forecast (every place spread evenly),
  // but top10 must still carry PLACES distinct ids or the document is not one. No id is known, so
  // emit none and let the place-spread fallback stand; the scorer rejects the file rather than
  // silently scoring a made-up chart.
  write({ probabilities: [], top10: [] });
  process.exit(0);
}

const NEAR = PLACES;          // ranks just below the scored places
const OUT = PLACES + 1;       // off the chart
const N = PLACES + 2;
/** How deep below the scored places the "near" state reaches. */
const NEAR_DEPTH = 8;
/** Laplace pseudo-count per transition. */
const ALPHA = 0.25;

const stateOf = (idx: number): number =>
  idx < 0 ? OUT : idx < PLACES ? idx : idx < PLACES + NEAR_DEPTH ? NEAR : OUT;

/** counts[i][j]: games at state i in one read and state j in the next. */
const counts: number[][] = Array.from({ length: N }, () => new Array<number>(N).fill(0));
let gapSum = 0, gapN = 0;
for (let c = 1; c < reads.length; c++) {
  const prev = reads[c - 1]!;
  const next = reads[c]!;
  const dt = (next.t - prev.t) / 60000;
  if (dt > 0 && Number.isFinite(dt)) { gapSum += dt; gapN++; }
  const at = new Map<number, number>();
  next.ids.forEach((g, j) => at.set(g, j));
  for (let i = 0; i < prev.ids.length; i++) {
    const g = prev.ids[i]!;
    const j = at.get(g);
    counts[stateOf(i)]![stateOf(j === undefined ? -1 : j)]! += 1;
  }
  const inPrev = new Set(prev.ids);
  for (let j = 0; j < next.ids.length; j++) {
    if (!inPrev.has(next.ids[j]!)) counts[OUT]![stateOf(j)]! += 1;
  }
}

/** Row-normalised transitions per read, Laplace-smoothed. */
const perRead: number[][] = counts.map((row) => {
  let sum = 0;
  for (let j = 0; j < N; j++) sum += row[j]! + ALPHA;
  return row.map((c) => (c + ALPHA) / sum);
});

function mul(A: number[][], B: number[][]): number[][] {
  const n = A.length;
  const R = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    const Ai = A[i]!, Ri = R[i]!;
    for (let k = 0; k < n; k++) {
      const a = Ai[k]!;
      if (a === 0) continue;
      const Bk = B[k]!;
      for (let j = 0; j < n; j++) Ri[j]! += a * Bk[j]!;
    }
  }
  return R;
}
function identity(n: number): number[][] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}
function normInf(A: number[][]): number {
  let m = 0;
  for (const r of A) { let s = 0; for (const v of r) s += Math.abs(v); if (s > m) m = s; }
  return m;
}
/** exp(A) by scaling and squaring with a Taylor series. */
function expm(A: number[][]): number[][] {
  const n = A.length;
  const m = normInf(A);
  const s = m > 0.5 ? Math.ceil(Math.log2(m / 0.5)) : 0;
  const sc = Math.pow(2, -s);
  const B = A.map((r) => r.map((v) => v * sc));
  let R = identity(n), term = identity(n);
  for (let k = 1; k <= 40; k++) {
    term = mul(term, B).map((r) => r.map((v) => v / k));
    R = R.map((r, i) => r.map((v, j) => v + term[i]![j]!));
    if (normInf(term) < 1e-18) break;
  }
  for (let i = 0; i < s; i++) R = mul(R, R);
  return R;
}
/** Row-normalise, clamping tiny negatives the exponential may leave. */
function stochastic(A: number[][]): number[][] {
  return A.map((r) => {
    const c = r.map((v) => (v > 0 ? v : 0));
    const s = c.reduce((a, b) => a + b, 0);
    return s > 0 ? c.map((v) => v / s) : new Array<number>(r.length).fill(1 / r.length);
  });
}

/** One step is one slot: raise the per-read matrix to 1/(slots per read) via its generator. */
const meanGapMin = gapN > 0 ? gapSum / gapN : 60;
const slotsPerRead = Math.max(1e-6, meanGapMin / SLOT_MIN);
const gen: number[][] = perRead.map((r, i) => r.map((v, j) => (v - (i === j ? 1 : 0)) / slotsPerRead));
const M: number[][] = stochastic(expm(gen));

function step(v: number[]): number[] {
  const w = new Array<number>(N).fill(0);
  for (let i = 0; i < N; i++) {
    const vi = v[i]!;
    if (vi === 0) continue;
    const mi = M[i]!;
    for (let j = 0; j < N; j++) w[j]! += vi * mi[j]!;
  }
  return w;
}

const last = reads[reads.length - 1]!;
const games: number[] = [...new Set(reads.flatMap((r) => r.ids))];
const start = new Map<number, number>();
for (const g of games) start.set(g, stateOf(last.ids.indexOf(g)));

/** Average the place distribution over the window's slots 1..SLOTS. */
const acc = new Map<number, number[]>();
for (const g of games) acc.set(g, new Array<number>(PLACES).fill(0));
for (const g of games) {
  let v = new Array<number>(N).fill(0);
  v[start.get(g)!] = 1;
  const rows = acc.get(g)!;
  for (let t = 0; t < SLOTS; t++) {
    v = step(v);
    for (let k = 0; k < PLACES; k++) rows[k]! += v[k]!;
  }
  for (let k = 0; k < PLACES; k++) rows[k]! /= SLOTS;
}

/**
 * Name the subset of each place's games the scorer rewards most. Given a belief p over the chart,
 * a named game scores ln p, while every unnamed game shares (1 - named mass) over the chart ids the
 * place does not name. The expected score of naming the top k is
 *   sum_{k} p ln p + (1 - sum_k) ln((1 - sum_k) / (C - k)),
 * so naming a game below that share spends mass from every other unnamed game; k is chosen per place
 * to maximise it (and k = 0, naming nothing, is always considered).
 */
const probabilities: Array<{ universe_id: number; place: number; p: number }> = [];
const argmax: number[] = [];

function expectedScore(belief: Array<{ id: number; p: number }>, k: number, chartSize: number): number {
  let used = 0;
  for (let i = 0; i < k; i++) used += belief[i]!.p;
  const pool = Math.max(1, chartSize - k);
  let e = 0;
  for (let i = 0; i < k; i++) {
    const p = belief[i]!.p;
    if (p > 0) e += p * Math.log(Math.max(p, 1e-4));
  }
  const rest = Math.max(0, 1 - used);
  if (rest > 0) e += rest * Math.log(Math.max(rest / pool, 1e-4));
  return e;
}

/**
 * A game is worth naming only if it could plausibly be on a scored read's chart: naming an id the
 * chart does not list still spends its p and buys nothing, and the history holds far more games
 * (about 550) than the chart ever lists (about 97). Candidates are the games of the recent reads,
 * where every climb into the top ten comes from, plus any game the belief still gives place mass.
 */
const RECENT_READS = 12;
const recent = new Set<number>();
for (let c = Math.max(0, reads.length - RECENT_READS); c < reads.length; c++) {
  for (const g of reads[c]!.ids) recent.add(g);
}

for (let k = 0; k < PLACES; k++) {
  // The belief over places, renormalised to a proper distribution over the chart: the mass that
  // leaked into "out" is real (the game may be off the chart) and is not renamed here.
  const raw = [...recent]
    .map((g) => ({ id: g, p: acc.get(g)![k]! }))
    .filter((x) => x.p > 0)
    .sort((a, b) => (b.p - a.p) || (a.id - b.id));
  const total = raw.reduce((a, x) => a + x.p, 0);
  const belief = total > 0 ? raw.map((x) => ({ id: x.id, p: x.p / total })) : raw;
  argmax.push(raw[0]?.id ?? last.ids[k] ?? last.ids[0]!);

  // The unnamed share is divided over the chart ids a scored read lists that the place does not
  // name, so the pool is the chart's own length (about 97, and stable across reads), never the
  // number of games the forecast happens to believe in.
  const chartSize = Math.max(1, last.ids.length);
  let bestK = 0;
  let bestE = expectedScore(belief, 0, chartSize);
  const cap = Math.min(belief.length, 40);
  for (let kk = 1; kk <= cap; kk++) {
    const e = expectedScore(belief, kk, chartSize);
    if (e > bestE + 1e-12) { bestE = e; bestK = kk; }
  }
  let used = 0;
  for (let i = 0; i < bestK; i++) {
    const x = belief[i]!;
    const p = Math.round(x.p * 1e6) / 1e6;
    if (p <= 0) continue;
    if (used + p > 0.999999) break;
    probabilities.push({ universe_id: x.id, place: k + 1, p });
    used += p;
  }
}

// top10: each place's argmax, kept distinct, then padded from the close read, older reads, the
// forecast's own names and finally any game seen -- the document must carry exactly PLACES distinct
// ids or the scorer rejects the whole file and every place takes the floor.
const top10: number[] = [];
const pushId = (id: number | undefined): void => {
  if (top10.length >= PLACES) return;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id >= 1 && !top10.includes(id)) top10.push(id);
};
for (const id of argmax) pushId(id);
for (const id of last.ids) pushId(id);
for (let c = reads.length - 2; c >= 0; c--) for (const id of reads[c]!.ids) pushId(id);
for (const p of probabilities) pushId(p.universe_id);
for (const id of games) pushId(id);

write({ probabilities, top10 });
