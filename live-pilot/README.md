# Live-pilot cases

Real incidents, reconstructed as replay cases for engineering validation
(AIC-127). They are design input and a proving ground for the investigation
loop. They are not evidence that the loop is good.

- **Never a benchmark scenario.** A live-pilot case is never added to the
  calibration or hold-out partitions or to the final-evaluation corpus. The
  case registry (`registry.mjs`) is disjoint from both, checked in both
  directions — see `test/live-pilot-partition.test.mjs` › "every benchmark
  calibration, holdout and REPLAY_SCENARIOS id is outside the live-pilot case
  registry".
- **Outside the candidate fingerprint.** Nothing under `packages/`, `apps/` or
  `scripts/` refers to this directory, and product code may not import it —
  see `test/live-pilot-partition.test.mjs` › "no file under packages/, apps/,
  scripts/, or the shared benchmark-experiment fixture references the
  live-pilot directory" and › "rejects packages/graph importing
  live-pilot/registry.mjs by relative path".
- **Model-visible and evaluator-only material are separate.** Each case names
  its fixture (what an investigation may read) apart from its historical truth
  (what only an evaluator may read) — see `test/live-pilot-partition.test.mjs`
  › "declares the live-pilot partition identity and exactly one frozen case,
  flowa-904, split into model-visible and evaluator-only path groups".
- **Any outcome is a valid outcome.** Stalled, ambiguous and inconclusive are
  legitimate pilot results. Neither the roles nor the status rules are tuned to
  make a case succeed.
