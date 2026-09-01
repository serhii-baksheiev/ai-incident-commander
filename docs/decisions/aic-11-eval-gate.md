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

The mutation is not a product mode, and it does not alter the replay scenarios:
it rewrites only the outcome object handed to it, one record deep. Restoration is
proved by `test/benchmark-evaluation.test.mjs` › "keeps the evidence mutation
scoped and leaves a later baseline green", which checks the scenarios remain
unchanged and runs a fresh green baseline after the mutation.

⚠ **Its lifetime is one callback invocation, but that callback is no longer
private to the test.** It moved to `test/fixtures/benchmark-experiment.mjs` so
the AIC-13 acceptance run could persist the same three experiments the suite
gates on, rather than a restatement of them — evidence about a copy is evidence
about the copy. The containment that matters is unchanged and is the sentence
above: the mutation reaches an outcome, never a scenario, never product code.
What changed is who may invoke the cycle, and the answer is now "anything that
imports the fixture", including a process outside `node --test`.
