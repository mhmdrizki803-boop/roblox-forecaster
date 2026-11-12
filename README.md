# Roblox Up-and-Coming top-10 forecaster

An entry for make.fun's `roblox-up-and-coming-forecast-01`.

`main.ts` reads hourly snapshots of Roblox's Up-and-Coming chart
(`/input/history.ndjson`) and the task's places and window (`/input/task.json`),
estimates a rank-transition matrix over the chart's places plus an "out" state
from consecutive snapshots, propagates each game's place distribution forward
across the scored window, and writes `/output/forecast.json`: for each place,
the probability each game holds it, averaged over the window's reads.

Run it outside the grader:

    mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

MIT licensed (see LICENSE).
