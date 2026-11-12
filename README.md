# Roblox Up-and-Coming top-10 forecaster

An entry for make.fun's `roblox-up-and-coming-forecast-01`.

`main.ts` reads the chart's history (`/input/history.ndjson`) and the task's
places and window (`/input/task.json`) and writes `/output/forecast.json`: for
each of the top 10 places, a probability for each game it names being there,
and a top-10 guess. Node 22, standard library only, no network, deterministic.

## What it does

1. **Transition matrix.** Across consecutive reads it counts where games go:
   each place 1..10, plus a *near* state (ranks just below the top ten, where
   most climbers come from) and an *out* state. Rows are Laplace-smoothed with
   alpha = 0.25 (Krichevsky-Trofimov), so a move never seen in the history is
   still possible: the score floors at 1e-4, and a hard zero would guarantee
   the -9.21 nat penalty for any real move it forbade.

2. **One step is one hour.** Reads are hours apart (the public archive's are
   3.6 to 11 hours; the house recorder's are hourly), so the per-read matrix
   is raised to 1/(slots per read) through its generator,
   `M^(1/g) = exp((M - I)/g)`, computed by scaling and squaring. Without this
   the model propagates 6x too much movement and the chart diffuses to noise -
   that single bug was worth about 15 nats.

3. **Horizon average.** One forecast is scored against every read in the
   window, so the per-slot place distributions are averaged over all
   `window.slots` steps instead of forecasting one endpoint. In the archive,
   only 35% of a top ten is still in the top ten after 72 hours, so the target
   is a blend of the near horizon and the churn.

4. **Naming.** The scorer gives a place's unnamed mass `(1 - sum)` to every
   chart game the place does not name, so naming a thin probability is not
   free: naming 60 games at 0.015 leaves each unnamed game 0.00027 (-8.2)
   instead of 0.0103 (-4.6). For each place the program picks the number of
   names that maximises
   `sum p ln p + (1 - sum) ln((1 - sum) / (chart - k))`,
   considering naming nothing.

## Measured

Reconstructed from the MIT archive `Kenny-Dhub/roblox-snapshots` (the same
source the kit's practice instance was built from; the reconstruction
reproduces 33 of the kit's 34 history reads exactly) and scored with a
reimplementation of the server's `grader/forecast/ranked.ts` that reproduces
the published house-baseline figure of -43.512039 to six decimals:

| | practice window | 37 backtest windows (mean) |
|---|---|---|
| house persistence baseline | -43.51 | -46.20 |
| this entry | **-35.65** | **-37.39** |
| oracle (window's empirical marginal) | -17.72 | -14.28 |

The margin is caveated honestly: the archive's reads are 3.6 to 11 hours
apart, while the final window is scored hourly, and the 37 windows overlap.
Results are stable across read cadence (sparse -38.97, hourly-resampled
-39.00, 2h -38.99), so the hourly final should behave like the backtest.

## Run it

    mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

Outside the grader `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for
`/input` and `/output`. Costs about 0.3 s and 90 MB.

MIT licensed (see LICENSE).
