# Oracle positive control

`behavior-evaluators-v0.2.json` is the output of `scripts/eval-oracle.mjs`: the
oracle arm (`@aic/evals/oracle`) over the calibration partition, scored by the
evaluator as it stood before any evaluator repair (AIC-113). The oracle knows
the answer. A metric it cannot bring to its best value is a metric that no arm
can be judged on until the evaluator or its ground truth is repaired (AIC-105).
That reading holds here because no fixture statement in the calibration corpus
equals its ground-truth predicate. The oracle fingerprints only the evidence it
cites, while the graph projection fingerprints everything it collected, so on a
corpus where some did match, a graph arm could score above the oracle on a
fingerprint metric.

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
