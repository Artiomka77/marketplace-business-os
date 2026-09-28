# Wave B Worker Binding

Reuses prior `WORKER_DECISION.md`.

## Choice
Extend existing `DashboardPeriodSnapshotJob` queue with distinct Wave B `formulaVersion`s.
Dedicated script: `scripts/dashboard/runProfitReadModelWorker.ts`
Concurrency=1. Modes: `queue-once` (default), `oneshot`, `queue`.

## Isolation
Wave B jobs filtered by `WAVE_B_PROFIT_FORMULAS` — does not claim Wave A V6 period jobs.
Priority default 40–50; no pool retune.

## Docker
Dockerfile target `profit-readmodel-worker` (candidate only — not deployed in this task).
