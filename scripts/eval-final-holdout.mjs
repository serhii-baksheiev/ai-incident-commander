/**
 * `npm run eval:final-holdout`
 *
 * The ONE caller of the `final-evaluation` corpus in this repository, and the
 * command AIC-19's "declared one-shot final hold-out evaluation" names.
 *
 * 🔴 **Why this exists as a separate command rather than a flag on
 * `eval:live-model`.** The hold-out is spent by executing it, so the guard has
 * to sit in front of the execution rather than beside it. Keeping the two
 * commands apart means the repeatable diagnostic cannot reach the hold-out even
 * by accident, and an audit row asserts that this file is the only place
 * outside `packages/evals/src/` and `test/` that names the corpus.
 * see final-evaluation-command.test.mjs › "reaches the final-evaluation corpus from exactly one command in this repository"
 *
 * ⚠ **This command spends something that cannot be un-spent.** There is no
 * `--force` and no `--again`: the only way past a refusal is a candidate whose
 * fingerprint moved — a real change to what the graph does — or a committed
 * void record carrying a reason and an author. A flag is invoked; a committed
 * void is argued for in review, and if voiding becomes routine the diffs say so.
 *
 * ⚠ An earlier version of this sentence said "human-authored", and the first
 * void record in this repository was written by an autonomous run. The property
 * that carries the honesty is that the void is a DIFF A REVIEWER READS, not the
 * species of whoever typed it; claiming otherwise would have been a guarantee
 * the mechanism does not provide.
 *
 * `--dry-run` runs every guard, prints the decision and executes nothing. It is
 * how a reviewer verifies a record and how this mechanism is exercised without
 * spending the corpus.
 *
 * The structural pieces below — `flag`/`option`, `headSha` with `childEnv`, the
 * publish-refusal shape and `invokedDirectly` — are the same four this
 * repository already worked out in `scripts/eval-live-model.mjs`, copied rather
 * than reinvented because each one is there for a measured reason its header
 * records.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readdirSync, readFileSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { argv, env, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

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

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Where the records live. Committed, one file per candidate. */
export const EVIDENCE_DIR = join(REPO_ROOT, 'docs', 'evidence', 'final-evaluation');

function flag(name) {
  return argv.includes(`--${name}`);
}

function option(name) {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
}

/** The same allow-listed spawn environment every `git` call in this repo gets. */
function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: childEnv(),
  }).trim();
}

function headSha() {
  return option('head-sha') ?? git(['rev-parse', 'HEAD']);
}

/**
 * The candidate: a hash over the git object ids of the declared paths.
 *
 * 🔴 Object ids, not file contents read from disk — `git ls-tree` answers for
 * what is COMMITTED, so a fingerprint cannot be quietly moved by an edit nobody
 * recorded. The working tree is checked separately and a dirty one is refused,
 * because a fingerprint that does not describe what ran is not evidence.
 */
export function candidateFingerprint() {
  const listing = evals.FINAL_EVALUATION_CANDIDATE_PATHS.map((path) =>
    git(['ls-tree', '-r', 'HEAD', '--', path]),
  ).join('\n');
  return `sha256:${createHash('sha256').update(listing).digest('hex')}`;
}

/** The corpus, hashed from the declared partition rather than from an arm's answer. */
export function corpusFingerprint(runsPerScenario) {
  const exampleIds = evals
    .createFinalEvaluationBenchmarkPlan({
      experimentId: 'aic-19-corpus-fingerprint',
      runsPerScenario,
      metadata: baseMetadata(),
    })
    .map(({ exampleId }) => exampleId)
    .sort();
  return {
    fingerprint: `sha256:${createHash('sha256').update(exampleIds.join('|')).digest('hex')}`,
    exampleIds,
  };
}

function baseMetadata() {
  return {
    evaluatorVersion: evals.BEHAVIOR_EVALUATOR_VERSION,
    graphVersion: 'aic-19-final-holdout',
    promptVersion: REFERENCE_PROMPT_VERSION,
    toolsetVersion: 'replay-v0.1',
    statusRulesVersion: STATUS_RULES_VERSION,
    knowledgeSetVersion: 'v0.2',
  };
}

/** Every record on disk, parsed. An unreadable one is a refusal, never an absence. */
export function readRecords(directory = EVIDENCE_DIR) {
  let names;
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch (error) {
    // 🔴 Only ENOENT. An absent directory has nothing to judge — the fail-open
    // case, and the only one; a fresh checkout must not be refused. Anything
    // else is a directory this guard was HANDED and could not read, which is
    // the refusal case: `.claude/rules/invariants.md` says reporting that is
    // the one thing it is for.
    //
    // The bare `catch` this replaces claimed exactly the sentence above and did
    // the opposite. Measured: `chmod 000` on the evidence directory turned six
    // records into zero and flipped `decideFinalEvaluation` to `{admit: true}`,
    // so a permissions accident or a path replaced by a file silently re-spent
    // the one-shot hold-out against a live provider — no refusal, no trace.
    // see final-evaluation-oneshot.test.mjs › "refuses an evidence directory it cannot read, rather than reporting no records"
    // see final-evaluation-oneshot.test.mjs › "reads a genuinely absent evidence directory as no records, which is the one fail-open case"
    if (error?.code !== 'ENOENT') {
      throw new Error(
        `the final evaluation evidence directory could not be read: an evidence directory in a state nobody understands is a refusal, not an absence — ${error.message}`,
      );
    }
    return [];
  }
  return names.map((name) => {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    } catch (error) {
      throw new Error(
        `the final evaluation record ${name} could not be read as JSON: an evidence directory in a state nobody understands is a refusal, not an absence — ${error.message}`,
      );
    }
    return evals.parseFinalEvaluationRecord(parsed);
  });
}

function recordPath(fingerprint) {
  return join(EVIDENCE_DIR, `${fingerprint.replace('sha256:', '').slice(0, 12)}.json`);
}

/**
 * Write the record, refusing an existing path rather than writing through it.
 *
 * `wx` is the same exclusive create `incident-lab/src/scenario-candidates.mjs`
 * and `.claude/scripts/run-state.mjs` already use, and here it is also the
 * mutual exclusion between two concurrent runs: the loser executes nothing.
 */
function claimRecord(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  const handle = openSync(path, 'wx');
  try {
    writeSync(handle, `${JSON.stringify(body, null, 2)}\n`);
  } finally {
    closeSync(handle);
  }
}

/**
 * The replay-backed lifecycle, with the two per-run maps it needs.
 *
 * ⚠ `replayBackedNodes` takes three arguments, and the first version of this
 * file passed one. The crash was `Cannot read properties of undefined (reading
 * 'get')` at the first record of the control arm — before any model call and
 * before any publication — and it is why record `04cf86236c2f` is void.
 */
function scriptedNodes(record) {
  return replayBackedNodes(
    record,
    new Map([[record.runId, []]]),
    new Map([[record.runId, 0]]),
  );
}

function modelNodes(record, port) {
  return {
    ...scriptedNodes(record),
    generate_hypotheses: createModelGenerateHypotheses({ port }),
    interpret_residual_evidence: createModelInterpretResidualEvidence({ port }),
    challenge_hypothesis: createModelChallengeHypothesis({ port }),
  };
}

async function main() {
  // 1. The credential first, so an unconfigured run creates no dataset, no
  //    project, no run and no record — the property the sibling command's
  //    header already states and this one inherits.
  // 🔴 `.available` is CHECKED, not just resolved. `resolveModelConfig` does not
  // throw — it returns `{available: false}` — so reading it and moving on left
  // the real refusal inside `runLiveModelLane`, seven lines AFTER the record was
  // claimed. Measured under `env -i` with no credential: the command wrote a
  // `claimed` record and exited 1 having executed no scenario and made no
  // provider call, and the next run was then refused with "the corpus is spent
  // when scenarios execute … so the runs happened" — a false statement, over a
  // run that never started, whose only remedy was a hand-written void record.
  // see final-evaluation-command.test.mjs › "refuses an unconfigured run before it claims the candidate"
  const config = resolveModelConfig(env);
  if (config.available !== true) {
    throw new Error(
      `no model provider credential is configured (${config.missing ?? MODEL_API_KEY_VARIABLE}): refusing before the candidate is claimed, because a claim asserts that scenarios executed`,
    );
  }

  // 2. The candidate, and a refusal if the tree does not match it.
  const dirty = git(['status', '--porcelain', '--', ...evals.FINAL_EVALUATION_CANDIDATE_PATHS]);
  if (dirty.length > 0) {
    throw new Error(
      `refusing to evaluate the hold-out with uncommitted changes under a candidate path:\n${dirty}\nA fingerprint that does not describe what ran is not evidence.`,
    );
  }
  const fingerprint = candidateFingerprint();
  const head = headSha();

  // 3. The corpus, from the declared partition.
  const runsPerScenario = Number(option('runs-per-scenario') ?? 3);
  const corpus = corpusFingerprint(runsPerScenario);

  // 4. Every record, parsed. 5. The decision.
  const records = readRecords();
  const decision = evals.decideFinalEvaluation({
    records,
    candidateFingerprint: fingerprint,
  });

  if (flag('dry-run')) {
    stdout.write(
      `${JSON.stringify(
        {
          dryRun: true,
          candidate: { fingerprint, headSha: head, workingTreeClean: true },
          corpus: {
            scenarioSet: 'final-evaluation',
            runsPerScenario,
            fingerprint: corpus.fingerprint,
            exampleCount: corpus.exampleIds.length,
          },
          recordsOnDisk: records.length,
          decision,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (!decision.admit) {
    throw new Error(`${decision.reason}\n\nRemedy: ${decision.remedy}`);
  }

  const path = recordPath(fingerprint);
  const claimedAt = new Date().toISOString();
  const base = {
    schemaVersion: evals.FINAL_EVALUATION_RECORD_VERSION,
    status: 'claimed',
    candidate: { fingerprint, algorithm: 'sha256-over-git-ls-tree', paths: [...evals.FINAL_EVALUATION_CANDIDATE_PATHS], headSha: head, workingTreeClean: true },
    corpus: {
      scenarioSet: 'final-evaluation',
      calibration: [...evals.BENCHMARK_SCENARIO_PARTITIONS.calibration],
      holdout: [...evals.BENCHMARK_SCENARIO_PARTITIONS.holdout],
      runsPerScenario,
      exampleIds: corpus.exampleIds,
      fingerprint: corpus.fingerprint,
    },
    claimedAt,
  };

  // 6. Claim BEFORE the first scenario. The corpus is spent when scenarios
  //    execute, not when the report is written, so a crash between here and the
  //    rewrite must leave a record that refuses the next run.
  claimRecord(path, base);

  const ledger = createModelUsageLedger({ maxCalls: evals.LIVE_MODEL_LANE_MAX_MODEL_CALLS });
  let modelExperiment;
  let publication = null;
  let publicationSkipped;

  const report = await evals.runLiveModelLane({
    env,
    scenarioSet: 'final-evaluation',
    experimentId: `aic-19-final-holdout-${head.slice(0, 12)}`,
    headSha: head,
    runsPerScenario,
    metadata: baseMetadata(),
    modelUsage: () => ledger.read(),
    async runControlArm(plan) {
      return evals.runGraphBenchmarkExperiment({
        experimentId: `aic-19-control-${head.slice(0, 12)}`,
        scenarioSet: plan.scenarioSet,
        runsPerScenario: plan.runsPerScenario,
        metadata: plan.metadata,
        createNodes: (record) => scriptedNodes(record),
        async recordEvaluation() {},
      });
    },
    async runModelArm(plan) {
      const port = createReferenceModelPort({
        apiKey: readModelCredential(env),
        modelId: config.modelId,
        ledger,
      });
      modelExperiment = await evals.runGraphBenchmarkExperiment({
        experimentId: `aic-19-model-${head.slice(0, 12)}`,
        scenarioSet: plan.scenarioSet,
        runsPerScenario: plan.runsPerScenario,
        metadata: { ...plan.metadata, modelId: config.modelId, modelProvider: config.provider },
        createNodes: (record) => modelNodes(record, port),
        async recordEvaluation() {},
      });
      return modelExperiment;
    },
    ...(flag('publish')
      ? {
          async publish(laneReport) {
            // 🔴 Skipped, not thrown. The sibling command throws here, and that
            // is right for a diagnostic: an unreportable arm must never reach
            // LangSmith as a model-quality result. But this command's throw
            // destroyed the RECORD — the one artifact the one-shot protocol
            // exists to produce — and a run that measured something and then
            // erased the measurement is the worst of the three outcomes.
            //
            // When the model arm refused there is also nothing to publish:
            // `modelExperiment` is never assigned, because the assignment is
            // the awaited call that threw. Publishing the CONTROL arm instead
            // would be worse than publishing nothing — AIC-19 forbids
            // presenting harness-only results as model judgement quality.
            if (!laneReport.arms.model.reportable || modelExperiment === undefined) {
              publicationSkipped =
                laneReport.arms.model.unreportableReason ??
                'the model arm produced no experiment to publish';
              return;
            }
            publication = await observability.persistBenchmarkExperiment({
              datasetName: `aic-19-final-holdout-${laneReport.headSha.slice(0, 12)}`,
              experiment: modelExperiment,
            });
          },
        }
      : {}),
  });

  // 9. Rewrite as complete. `publication` is absent-with-a-reason rather than an
  //    empty identity: a synthesised id or URL would be a fabricated
  //    measurement, and the rule that a missing measurement never becomes a zero
  //    is the same rule.
  const complete = {
    ...base,
    status: 'complete',
    completedAt: new Date().toISOString(),
    report,
    publication:
      publication === null
        ? {
            status: 'absent',
            absentReason:
              publicationSkipped ??
              (flag('publish')
                ? 'the publish step did not run'
                : 'the run was not asked to publish (--publish was not passed)'),
          }
        : { status: 'published', ...publication },
    acceptance: [
      {
        requirement: 'final evidence names the exact candidate SHA',
        met: true,
        evidence: 'candidate.headSha',
      },
      {
        requirement: 'final evidence carries native LangSmith identities',
        met: publication !== null,
        evidence: publication === null ? 'publication.absentReason' : 'publication.datasetId, publication.projects[].projectId, publication.runIds',
      },
      {
        requirement: 'the model arm is reportable',
        met: report.arms.model.reportable === true,
        evidence: report.arms.model.reportable === true ? 'report.arms.model' : 'report.arms.model.unreportableReason',
      },
    ],
  };
  writeFileSync(path, `${JSON.stringify(complete, null, 2)}\n`);

  const serialized = `${JSON.stringify(complete, null, 2)}\n`;
  stdout.write(serialized);
  const outPath = option('out');
  if (outPath !== undefined) writeFileSync(outPath, serialized);
}

/** Realpath on both sides, for the reason `eval-live-model.mjs` records at length. */
const invokedDirectly = () => {
  if (!argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(argv[1]) === real(fileURLToPath(import.meta.url));
};

if (invokedDirectly()) {
  main().catch((error) => {
    stderr.write(`${error.message}\n`);
    if (error instanceof Error && error.name === 'MissingModelCredentialError') {
      stderr.write(`Set ${MODEL_API_KEY_VARIABLE} and run again.\n`);
    }
    exit(1);
  });
}
