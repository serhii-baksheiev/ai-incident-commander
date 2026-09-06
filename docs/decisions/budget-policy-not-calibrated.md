# Why the investigation budgets are versioned but not calibrated

AIC-18 asked for `maxIterations`, `llmCallBudget` and `reservedChallengeBudget`
to be tuned from benchmark evidence. They were not tuned. The shipped values are
unchanged, and this file is why — so that the next reader does not conclude the
work was skipped, and does not "finish" it by picking numbers.

It is not loaded into any session.

## What was measured

The calibration partition — 8 scenarios × 3 runs = 24 runs — taken through
`runGraphBenchmarkExperiment` with the replay-backed nodes, once per candidate
policy, comparing the stop-kind distribution, each run's `actualStopKind`, every
benchmark metric, every behaviour metric and every deterministic resource axis.

| policy (`maxIterations` / `llmCallBudget` / `reservedChallengeBudget`) | result |
| --- | --- |
| `4 / 8 / 2` — shipped | the baseline |
| `0 / 0 / 2` — spend nothing | identical evidence on all 24 runs |
| `1 / 1 / 1`, `64 / 1024 / 8`, and the arms between | identical evidence on all 24 runs |
| `4 / 8 / 0` | every run stops `budget-exhausted`; no metric score and no resource axis moves |

The rows are executable rather than recorded here: `budget-policy.test.mjs` ›
"publishes identical evidence at zero logical budget, because nothing reaches
that edge" and › "exhausts every run at a zero challenge reserve while no metric
and no resource axis moves".

## Why two of the three cannot be calibrated by any corpus this repository runs

`maxIterations` and `llmCallBudget` are read on exactly one edge — the
`need-more-evidence` route out of `termination_check`
(`packages/graph/src/investigation.ts`, the branch that terminates
`budget-exhausted`). **No node outside `test/` returns that route.** Both
benchmark arms use the replay-backed lifecycle, whose `termination_check`
returns `terminal` / `sufficient`, and the model arm replaces three reasoning
roles without touching it.

So the degenerate policy — allow nothing — is indistinguishable from the shipped
one. That is a proof of unreachability, not a weak signal, and it means no
amount of running this corpus can choose those two numbers. They still bound a
run that ever takes that edge, which is why they are kept rather than deleted.

## Why the third is reached and still does not calibrate

`reservedChallengeBudget` is genuinely reached, because a `sufficient` decision
with no challenge round behind it is forced through the mandatory challenge. But
`MAX_CHALLENGE_ROUNDS` is 2 and this corpus uses one round, so `1`, `2` and `8`
behave identically. Only `0` differs — and it stops every run
`budget-exhausted`, which moves the accepted v0.1 outcome.

That direction is refused rather than accepted as a cheaper policy: the standing
ruling on AIC-18 is that a candidate changing any frozen v0.1 individual outcome
is rejected as a candidate, and the baseline is not moved under it.

⚠ One detail worth keeping, because a shorter version of it was wrong once: at
`reservedChallengeBudget: 0` the `challenge_effect` **score** stays 0 while its
**reason** moves from `no-investigation-change` to `challenge-not-observed`. No
metric *score* moves and no resource axis moves; a behaviour reason does. The
rows compare behaviour scores rather than metric objects for exactly this
reason.

## What was built instead

Not numbers — the ability to have asked the question at all, and an honest
report of the answer.

- The three budgets became one frozen, versioned `BENCHMARK_BUDGET_POLICY`.
  Before this they were literals inside a module-private function, so varying
  one required patching the source of a shipped package. That is why they had
  never been examined.
- `runGraphBenchmarkExperiment` takes an optional `budgetPolicy`. Only the graph
  runner does: `runBenchmarkExperiment` drives an opaque callback and starts no
  graph, so a policy handed to it would reach no control block.
- Parsing fails closed and names the offending field, before the first scenario
  runs. An **absent** option defaults; an option **present** in a shape the
  runner cannot read is refused. `?? BENCHMARK_BUDGET_POLICY` collapsed those
  two states and let an explicit `null` run the whole corpus under a policy the
  caller never asked for — found by mutation, and the reason `Object.hasOwn`
  is there.
- `summarizeBudgetPolicyEvidence` reports one row per policy arm keyed by its
  declared version, every metric and every axis on its own row, and a
  calibration statement per budget. All three say *not empirically calibrated*,
  with three different reasons, because the sweep found three different things.

## No composite, and why the absence is tested

The report has no composite, no weighted total and no efficiency ratio. A single
figure blending quality with spend can fall while quality falls with it, which
is the reading AIC-18 was explicitly told not to produce. The absence is
asserted by walking every key at every depth rather than by checking known
names, because the failure guarded against is a key **added** later:
`budget-policy.test.mjs` › "publishes no composite or aggregate score anywhere
in the report".

## What would change this conclusion

One thing, and it is a change to the system under test rather than a
calibration: a node that returns `need-more-evidence`, or a corpus that needs
more than one iteration. On the day either lands, the identical-evidence rows go
red — which is the point of writing them as rows rather than as this paragraph.
Their failure message says so.

Until then, `llmCallBudget` in particular is a versioned safety cap whose value
no measurement chose, and the report says that in the same place it publishes
the number.
