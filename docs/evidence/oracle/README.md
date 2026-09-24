# Oracle positive control

`behavior-evaluators-v0.2.json` is the output of `scripts/eval-oracle.mjs`: the
oracle arm (`@aic/evals/oracle`) over the calibration partition, scored by the
evaluator as it stood before any evaluator repair (AIC-113). The oracle knows
the answer. A metric it cannot bring to its best value is a metric that no arm
can be judged on until the evaluator or its ground truth is repaired (AIC-105).

The file is generated, not written by hand. A test keeps it equal to a fresh
run, and a second test pins the same table against numbers read off the code by
hand:

- `test/oracle-positive-control.test.mjs` › "scripts/eval-oracle.mjs prints
  JSON on stdout that deep-equals the committed evidence file"
- `test/oracle-positive-control.test.mjs` › "scores the calibration partition
  exactly as hand-derived from behavior-evaluators.ts and replay-scenarios.ts"

Why the oracle cites no evidence on any calibration scenario:
`test/oracle-positive-control.test.mjs` › "oracleAnswerFor identifies no
evidence for bad-deployment, because no fixture statement equals the
ground-truth predicate".

`unsupported_claim_rate` is at its best only where `claimCount` is 0, which
means the oracle made no claim, not that it supported one. Read the score
together with the count every time.

## After the structural repair (AIC-105)

`behavior-evaluators-v0.3.json` is the same report under the structural
evaluator (`npm run eval:oracle -- --evaluator-version behavior-evaluators-v0.3`).
That evaluator matches evidence by the fixture ids an arm referenced and root
causes by a closed taxonomy (`packages/evals/src/structural-ground-truth.ts`).
The v0.2 file above stays as it was measured.

- `test/structural-evaluator.test.mjs` › "docs/evidence/oracle/behavior-evaluators-v0.3.json
  deep-equals a fresh run of the v0.3 report"
- `test/structural-evaluator.test.mjs` › "scripts/eval-oracle.mjs
  --evaluator-version behavior-evaluators-v0.3 prints exactly the hand-derived
  v0.3 calibration table"

In that table every metric reaches its best value on every calibration
scenario. On false-alert and multiple-plausible-causes, `unsupported_claim_rate`
is at its best because `claimCount` is 0: the ground truth names no cause
there, so the oracle makes no claim.
