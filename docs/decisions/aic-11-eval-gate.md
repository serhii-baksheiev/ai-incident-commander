# AIC-11 mutation-verified eval gate

## Protected invariant

Every required v0.1 evidence fingerprint must be present in the evaluated
evidence. The gate stays per metric: an evidence regression fails
`evidence_coverage` without being hidden by a composite score.

The executable proof is
`test/benchmark-evaluation.test.mjs` › "gates a controlled benchmark mutation
independently for each metric". It compares the same 15 stable examples under
separate baseline and mutation experiment references, records the tested head
SHA, and requires the baseline to pass before showing the scoped missing-evidence
mutation fail only `evidence_coverage`.

The mutation is not a product mode or a changed fixture. Its lifetime is the
candidate experiment callback in that test. Restoration is proved by
`test/benchmark-evaluation.test.mjs` › "keeps the evidence mutation scoped and
leaves a later baseline green", which checks the fixtures remain unchanged and
runs a fresh green baseline after the mutation.
