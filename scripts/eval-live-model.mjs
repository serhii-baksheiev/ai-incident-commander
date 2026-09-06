#!/usr/bin/env node
/**
 * The bounded live-model evaluation lane, as a command.
 *
 * `npm run eval:live-model`
 *
 * Two arms over the accepted hold-out corpus, at one commit, in one process:
 *
 *   - a SCRIPTED control arm — the deterministic nodes the regression suite
 *     already uses — and
 *   - a MODEL arm, identical except that `generate_hypotheses`,
 *     `interpret_residual_evidence` and `challenge_hypothesis` are backed by the
 *     reference model.
 *
 * Everything else about the two arms is the same object graph, which is what
 * makes the comparison mean anything: if the control arm's numbers move against
 * their declared baseline, the change is in the HARNESS and the model arm's
 * numbers are marked UNREPORTABLE.
 * ⚠ Marked, not withheld — `arms.model.metrics` still carries every model mean
 * on that verdict and only `reportable` flips; `--publish` is what refuses on
 * it. A consumer reading `metrics` without checking `reportable` gets numbers
 * an earlier wording here said were withheld. (Distinct from
 * `LIVE_MODEL_LANE_WITHHELD_METRICS`, which really does withhold a metric —
 * that mechanism is unrelated to this verdict.)
 *
 * 🔴 **With no provider credential this command exits non-zero and touches
 * nothing** — no dataset, no project, no run, no model call. That refusal is the
 * only part of this command that has ever been executed in this repository:
 * there is no `ANTHROPIC_API_KEY` in this environment, so no run of this lane
 * has produced a model number, and none of its output should be read as one.
 *
 * Flags:
 *   --control-baseline <path>  JSON `{ "<metric>": <mean>, … }`. Without it the
 *                              lane still runs and still reports, and marks the
 *                              model arm unreportable: a metric that moved
 *                              cannot be attributed without a control baseline.
 *   --publish                  Send the model arm to LangSmith. Off by default,
 *                              so the lane produces local per-metric evidence
 *                              with no ingestion involved. An ingestion refusal
 *                              propagates and fails the command; it is never
 *                              reported as a completed publication.
 *   --out <path>               Write the JSON report here as well as to stdout.
 *
 * 🔴 **What the control arm can and cannot catch — and it is less than it
 * sounds.** It is the replay-backed lifecycle the regression suite runs, and
 * measured over the final-evaluation corpus it scores a single value of ZERO on
 * every metric it emits. Zero is the worst score for five of the six. So this
 * control arm catches a harness change that moves a metric UP, or that stops
 * emitting one — and it cannot catch one that pushes any metric further down,
 * because there is no further down. A `harness-regression` verdict from this
 * command means the first kind; its silence does not mean the second did not
 * happen.
 *
 * An earlier version of this paragraph named two metrics as the exception,
 * which read as an exhaustive carve-out and was not one. The set is asserted
 * rather than counted here, so it cannot drift again:
 * see live-model-lane.test.mjs › "measures the harness zero that makes
 * evidence_coverage unreportable"
 *
 * ⚠ **What leaves this process when the lane runs.** The prompt carries the
 * incident, the hypotheses, the predictions, the evidence and the assessments —
 * the investigation state — to the configured provider's HTTPS endpoint. That is
 * the only destination the lane reaches on its own; `--publish` adds a second,
 * the LangSmith ingestion below. Nothing leaves at all without a credential.
 *
 * The scripted nodes come from `test/fixtures/benchmark-experiment.mjs`, which
 * is the ONE implementation of the replay-backed lifecycle in this repository
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation"). A copy
 * here would be a control arm that could drift away from the arm the regression
 * suite actually runs, which is precisely the harness change this lane exists to
 * detect.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { argv, env, exit, stderr, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

import { STATUS_RULES_VERSION } from '@aic/domain';
import * as evals from '@aic/evals';
import * as observability from '@aic/observability';
import {
  MODEL_API_KEY_VARIABLE,
  REFERENCE_PROMPT_VERSION,
  createModelChallengeHypothesis,
  createModelGenerateHypotheses,
  createModelInterpretResidualEvidence,
  createModelUsageLedger,
  createReferenceModelPort,
  readModelCredential,
  resolveModelConfig,
} from '@aic/roles';

import { replayBackedNodes } from '../test/fixtures/benchmark-experiment.mjs';
import { childEnv } from '../test/fixtures/child-env.mjs';

function flag(name) {
  return argv.includes(`--${name}`);
}

function option(name) {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
}

function headSha() {
  return (
    option('head-sha') ??
    execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      // The one spawn in this command, and it gets the same allow-listed
      // environment every spawn in the test tree gets. Without it `git`
      // inherits ANTHROPIC_API_KEY, LANGSMITH_API_KEY and whatever else the
      // operator's shell carries — a shadowed `git` would then read them.
      // `test/child-process-environment.test.mjs` audits `test/` only, so
      // nothing would have caught this. Found by `security-scanner` at the
      // AIC-94 gate.
      env: childEnv(),
    }).trim()
  );
}

const baseMetadata = Object.freeze({
  graphVersion: 'graph-v0.2',
  promptVersion: REFERENCE_PROMPT_VERSION,
  toolsetVersion: 'toolset-v0.1',
  statusRulesVersion: STATUS_RULES_VERSION,
  evaluatorVersion: evals.BEHAVIOR_EVALUATOR_VERSION,
  // Both arms replay their TOOLS. Only the three roles differ between them,
  // which is what keeps the comparison about the model rather than about the
  // environment the two arms ran against.
  toolMode: 'replay',
  knowledgeSetVersion: 'knowledge-none-v0.1',
  memoryEnabled: false,
  temperature: 0,
  docsAvailable: false,
});

/** The deterministic arm: the replay-backed nodes, unchanged. */
export function scriptedNodes(record) {
  return replayBackedNodes(record, new Map([[record.runId, []]]), new Map([[record.runId, 0]]));
}

/**
 * The model arm: the same nodes with the three roles swapped for model-backed
 * ones. `execute_investigation` still replays the recorded tool calls, so the
 * evidence both arms see is identical and the only difference is who reasoned
 * over it.
 */
export function modelNodes(record, port) {
  return {
    ...scriptedNodes(record),
    generate_hypotheses: createModelGenerateHypotheses({ port }),
    interpret_residual_evidence: createModelInterpretResidualEvidence({ port }),
    challenge_hypothesis: createModelChallengeHypothesis({ port }),
  };
}

async function main() {
  const config = resolveModelConfig(env);
  const ledger = createModelUsageLedger({
    maxCalls: evals.LIVE_MODEL_LANE_MAX_MODEL_CALLS,
  });
  const declaredBaselinePath = option('control-baseline');
  const controlBaseline =
    declaredBaselinePath === undefined
      ? undefined
      : JSON.parse(readFileSync(declaredBaselinePath, 'utf8'));

  // Captured so `publish` sends the experiment that ran rather than a summary
  // of it: the LangSmith record has to be the runs, not the report about them.
  let modelExperiment;

  const report = await evals.runLiveModelLane({
    env,
    experimentId: `aic-94-live-model-${headSha().slice(0, 12)}`,
    headSha: headSha(),
    metadata: baseMetadata,
    controlBaseline,
    modelUsage: () => ledger.read(),
    async runControlArm(plan) {
      return evals.runGraphBenchmarkExperiment({
        experimentId: `aic-94-control-${headSha().slice(0, 12)}`,
        scenarioSet: plan.scenarioSet,
        runsPerScenario: plan.runsPerScenario,
        metadata: plan.metadata,
        createNodes: (record) => scriptedNodes(record),
        async recordEvaluation() {},
      });
    },
    async runModelArm(plan) {
      // The credential's VALUE is read through `readModelCredential`, the same
      // function `resolveModelConfig` uses for its availability decision — not a
      // second `env[...]` of this file's own. The two diverged before: the
      // config validated a trimmed value while this line sent the raw one, so a
      // credential could be judged usable in one shape and transmitted in
      // another.
      //
      // ⚠ That reader lives in `packages/roles`, so "the value is never touched
      // under `packages/`" — which an earlier version of this comment said — is
      // not true and was not true before either. What IS true is narrower and is
      // the property worth having: exactly one function reads it.
      // see roles-boundary.test.mjs › "reads the credential value in
      // readModelCredential and nowhere else in packages or scripts"
      const apiKey = readModelCredential(env);
      const port = createReferenceModelPort({
        apiKey,
        modelId: config.modelId,
        ledger,
      });
      modelExperiment = await evals.runGraphBenchmarkExperiment({
        experimentId: `aic-94-model-${headSha().slice(0, 12)}`,
        scenarioSet: plan.scenarioSet,
        runsPerScenario: plan.runsPerScenario,
        metadata: {
          ...plan.metadata,
          modelId: config.modelId,
          modelProvider: config.provider,
        },
        createNodes: (record) => modelNodes(record, port),
        async recordEvaluation() {},
      });
      return modelExperiment;
    },
    ...(flag('publish')
      ? {
          async publish(laneReport) {
            // Deliberately not wrapped in a retry: an ingestion refusal must
            // fail this command rather than be smoothed into a success.
            if (!laneReport.arms.model.reportable) {
              throw new Error(
                `refusing to publish an unreportable model arm: ${laneReport.arms.model.unreportableReason}`,
              );
            }
            await observability.persistBenchmarkExperiment({
              datasetName: `aic-94-live-model-${laneReport.headSha.slice(0, 12)}`,
              experiment: modelExperiment,
            });
          },
        }
      : {}),
  });

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  stdout.write(serialized);
  const outPath = option('out');
  if (outPath !== undefined) writeFileSync(outPath, serialized);
}

// The lane runs when this file IS the command, and not when it is imported.
// Without the guard the two arms above cannot be compared as objects by anything
// other than a reader of this file, because importing the module would run the
// lane — and a comparison nobody can execute is an argument, not a test.
// see live-model-lane.test.mjs › "runs its lane only when it is the process entry point"
if (argv[1] !== undefined && pathToFileURL(argv[1]).href === import.meta.url) {
  main().catch((error) => {
    stderr.write(`${error.name}: ${error.message}\n`);
    exit(1);
  });
}
