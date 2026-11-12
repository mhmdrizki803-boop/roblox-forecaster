// roblox-up-and-coming-forecast-01 entry (Node 22, standard library only).
//
// Reads /input/history.ndjson (hourly reads of Roblox's Up-and-Coming chart) and /input/task.json,
// estimates a rank-transition matrix over the chart's places (plus an "out" state) from consecutive
// snapshots, propagates each game's place distribution forward one hour at a time across the scored
// window, and writes /output/forecast.json: for each place, the probability each game holds it,
// averaged over the window's reads. Mass no game in the history accounts for stays unnamed.
//
// Outside the grader: MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Row { rank: number; universe_id: number; name?: string; playing?: number }
interface Snap { at?: string; up_and_coming?: Row[]; ok?: boolean; slot?: number | null }

const task = JSON.parse(readFileSync(join(INPUT_DIR, 'task.json'), 'utf8')) as {
  places?: number; output?: string; window?: { slots?: number };
};
const PLACES: number = task.places ?? 10;
const SLOTS: number = task.window?.slots ?? 72;
const OUTNAME: string = task.output ?? 'forecast.json';

const raw = readFileSync(join(INPUT_DIR, 'history.ndjson'), 'utf8').split('\n').filter((l) => l.trim() !== '');
const charts: number[][] = [];
for (const line of raw) {
  let s: Snap;
  try { s = JSON.parse(line) as Snap } catch { continue }
  const ua = s.up_and_coming;
  if (!ua || ua.length === 0) continue;
  charts.push([...ua].sort((a, b) => a.rank - b.rank).slice(0, PLACES).map((r) => r.universe_id));
}
if (charts.length === 0) {
  writeFileSync(join(OUTPUT_DIR, OUTNAME), `${JSON.stringify({ probabilities: [], top10: [] })}\n`);
  process.exit(0);
}

const OUT = PLACES;   // a game off the chart
const N = PLACES + 1;
const ALPHA = 0.15;   // light smoothing: the chart is mobile, keep the observed moves dominant

/** counts[i][j]: games that were at state i in one read and state j in the next. */
const counts: number[][] = Array.from({ length: N }, () => new Array<number>(N).fill(0));
for (let c = 1; c < charts.length; c++) {
  const prev = charts[c - 1]!;
  const next = charts[c]!;
  const at = new Map<number, number>();
  next.forEach((g, j) => at.set(g, j));
  const is = new Set(next);
  const was = new Set(prev);
  prev.forEach((g, i) => {
    const j = at.get(g);
    counts[i!]![j === undefined ? OUT : j]! += 1;
    if (!is.has(g)) counts[i!]![OUT]! += 0;
  });
  next.forEach((g, j) => { if (!was.has(g)) counts[OUT]![j]! += 1 });
  prev.forEach((g, i) => { if (!is.has(g)) counts[i!]![OUT]! += 1 });
}

/** Row-normalised transition matrix with Laplace smoothing. */
const M: number[][] = counts.map((row) => {
  const sum = row.reduce((a, b) => a + b + ALPHA, 0);
  return row.map((c) => (c + ALPHA) / sum);
});

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

const last = charts[charts.length - 1]!;
const games: number[] = [...new Set(charts.flat())];
const startState = new Map<number, number>();
for (const g of games) {
  const i = last.indexOf(g);
  startState.set(g, i === -1 ? OUT : i);
}

/** acc[g][k]: how often game g is expected at place k across the window's reads. */
const acc = new Map<number, number[]>();
for (const g of games) acc.set(g, new Array<number>(PLACES).fill(0));

for (const g of games) {
  let v = new Array<number>(N).fill(0);
  v[startState.get(g)!] = 1;
  const rows = acc.get(g)!;
  for (let t = 0; t < SLOTS; t++) {
    v = step(v);
    for (let k = 0; k < PLACES; k++) rows[k]! += v[k]!;
  }
  for (let k = 0; k < PLACES; k++) rows[k]! /= SLOTS;
}

const probabilities: Array<{ universe_id: number; place: number; p: number }> = [];
const best: Array<{ id: number; p: number }> = new Array(PLACES).fill({ id: 0, p: -1 });
for (let k = 0; k < PLACES; k++) {
  const ranked = games
    .map((g) => ({ id: g, p: acc.get(g)![k]! }))
    .filter((x) => x.p > 0.002)
    .sort((a, b) => b.p - a.p)
    .slice(0, 9);
  let used = 0;
  for (const r of ranked) {
    if (used + r.p > 0.95) break;
    probabilities.push({ universe_id: r.id, place: k + 1, p: Number(r.p.toFixed(6)) });
    used += r.p;
  }
  if (ranked[0]) best[k] = { id: ranked[0]!.id, p: ranked[0]!.p };
}
const top10 = best.map((b) => b.id).filter((id) => id !== 0);

writeFileSync(join(OUTPUT_DIR, OUTNAME), `${JSON.stringify({ probabilities, top10 })}\n`);
