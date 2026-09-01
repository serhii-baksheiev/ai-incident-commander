# Replay scenarios

Versioned deterministic replay fixtures are declared in
`packages/evals/src/replay-scenarios.ts`. `BENCHMARK_SCENARIO_PARTITIONS`
assigns every scenario to exactly one role: eight calibration cases and two
hold-out cases (`incomplete-evidence` and `challenge-changes-leader`).

Prompt/model iteration uses `createCalibrationBenchmarkPlan()`, which ignores a
caller-supplied `scenarios` property and selects the declared calibration IDs;
the executable runner's `scenarioSet: 'calibration'` mode rejects hold-out
input before investigation starts. Final evaluation uses
`createFinalEvaluationBenchmarkPlan()` to construct both partitions and the
runner's `scenarioSet: 'final-evaluation'` mode to execute them. The five v0.1
scenarios remain unchanged regression cases with their existing stable example
identities.

See `test/replay-scenarios.test.mjs` › "preserves the five accepted v0.1 ground
truths and replay fixtures" and `test/benchmark-evaluation.test.mjs` ›
"declares a complete non-overlapping calibration and hold-out policy before
tuning", › "keeps prompt and model iteration off hold-out cases even when they
are passed accidentally", › "includes calibration and hold-out cases in the
final evaluation plan", › "executes every declared scenario through the
final-evaluation benchmark path", and › "adds stable native identities without
changing the fifteen accepted v0.1 examples".
