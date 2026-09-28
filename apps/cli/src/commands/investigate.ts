import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  deriveHypothesisStatus,
  INCIDENT_STATE_SCHEMA_VERSION,
  STATUS_RULES_VERSION,
  type Incident,
  type IncidentState,
} from '@aic/domain';
import {
  createInvestigationGraph,
  createInvestigationNodes,
  INVESTIGATION_ROUTES,
  PREDICTION_TEMPLATES,
  type InvestigationReasoning,
} from '@aic/graph';
import {
  createModelChallengeHypothesis,
  createModelGenerateHypotheses,
  createModelInterpretResidualEvidence,
  createModelProposeConclusion,
  createModelUsageLedger,
  createReferenceModelPort,
  createScriptedReasoning,
  readModelCredential,
  requireModelConfig,
} from '@aic/roles';
import type { PlannedReplayScenarioFixture } from '@aic/tools/replay';
import { createPlannedReplayExecutor } from '@aic/tools/replay';

/**
 * AIC-126 slice b: `aic investigate`, a minimal real product entry that runs
 * ONE investigation through the exact same canonical composition the live
 * lanes use — `createInvestigationNodes` (`@aic/graph`) over the
 * planned-replay port (`@aic/tools/replay`) — outside any eval script. It
 * never imports `@aic/evals`: the dependency-cruiser rule
 * `benchmark-ground-truth-is-evaluator-side-only` forbids it, and this
 * command takes its replay fixture, budget and incident from the file the
 * caller names instead of a benchmark scenario.
 * see cli-investigate.test.mjs › "the scripted-roles CLI run is the same
 * composition the lanes use: printed stopKind/trials/evidence equal what
 * scriptedNodes(record) produces through createInvestigationGraph for the
 * same replay fixture"
 */
export const investigateHelp = `Usage: aic investigate --replay <file> [--roles model|scripted] [--run-id <id>]

Options:
  --replay   Path to a replay file: { asOf, incident, budget, fixture }
  --roles    "model" (default) or "scripted"
  --run-id   Run identity (default: a generated id)
  --help     Show this help`;

interface ReplayBudget {
  readonly maxIterations: number;
  readonly llmCallBudget: number;
  readonly reservedChallengeBudget: number;
}

interface ReplayFileContent {
  readonly asOf: string;
  readonly incident: Incident;
  readonly budget: ReplayBudget;
  readonly fixture: PlannedReplayScenarioFixture;
}

function readReplayFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`--replay file could not be read at ${path}: ${message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`--replay file at ${path} is not valid JSON: ${message}`);
  }
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `--replay file budget.${field} must be a positive integer, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function parseBudget(value: unknown): ReplayBudget {
  const record = ownRecord(value);
  if (record === undefined) {
    throw new Error('--replay file is missing required field budget');
  }
  return {
    maxIterations: requirePositiveInteger(record.maxIterations, 'maxIterations'),
    llmCallBudget: requirePositiveInteger(record.llmCallBudget, 'llmCallBudget'),
    reservedChallengeBudget: requirePositiveInteger(record.reservedChallengeBudget, 'reservedChallengeBudget'),
  };
}

function parseAsOf(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('--replay file is missing required field asOf: the CLI never defaults it to the clock');
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`--replay file asOf is not a parseable instant: ${JSON.stringify(value)}`);
  }
  return value;
}

function parseReplayFileContent(raw: unknown): ReplayFileContent {
  const record = ownRecord(raw);
  if (record === undefined) {
    throw new Error('--replay file must contain a JSON object');
  }
  const asOf = parseAsOf(record.asOf);
  const budget = parseBudget(record.budget);
  const incident = ownRecord(record.incident);
  if (incident === undefined) {
    throw new Error('--replay file is missing required field incident');
  }
  const fixture = ownRecord(record.fixture);
  if (fixture === undefined || !Array.isArray(fixture.entries)) {
    throw new Error('--replay file is missing required field fixture');
  }
  return {
    asOf,
    incident: incident as unknown as Incident,
    budget,
    fixture: fixture as unknown as PlannedReplayScenarioFixture,
  };
}

/**
 * The full initial `IncidentState` this run starts from, built from the
 * domain's own schema-version constants and the replay file's `incident` and
 * `budget` — never a literal this command keeps in sync by hand.
 * see cli-investigate.test.mjs's own `directInitialStateFor` helper, the same
 * shape.
 */
function buildInitialState(runId: string, content: ReplayFileContent): IncidentState {
  return {
    incident: content.incident,
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: {
      runId,
      schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
      statusRulesVersion: STATUS_RULES_VERSION,
      phase: 'normalizing',
      maxIterations: content.budget.maxIterations,
      llmCallBudget: content.budget.llmCallBudget,
      reservedChallengeBudget: content.budget.reservedChallengeBudget,
      challengeRounds: 0,
      iterationsUsed: 0,
      llmCallsUsed: 0,
      resumeCount: 0,
      humanReview: false,
    },
  };
}

/**
 * The model arm's four reasoning roles, over the mechanism vocabulary
 * `@aic/graph`'s own `PREDICTION_TEMPLATES` registers — never
 * `evals.ROOT_CAUSE_MECHANISMS`, which this command cannot import. The two
 * are pinned equal elsewhere: prediction-nodes.test.mjs › "PREDICTION_TEMPLATES.
 * byMechanism carries exactly one key per ROOT_CAUSE_MECHANISMS entry, in both
 * directions".
 *
 * The credential is resolved through `@aic/roles` before anything else this
 * command does — `requireModelConfig` throws `MissingModelCredentialError`,
 * naming the missing variable, with no network reached — the same function
 * `scripts/eval-live-model.mjs` calls for the same reason.
 * see cli-investigate.test.mjs › "aic investigate --roles model with no
 * ANTHROPIC_API_KEY in the child env exits non-zero, writes nothing to
 * stdout, names the missing variable on stderr, and reaches no network"
 */
function buildModelReasoning(env: NodeJS.ProcessEnv, budget: ReplayBudget): InvestigationReasoning {
  const config = requireModelConfig(env);
  const mechanisms = Object.keys(PREDICTION_TEMPLATES.byMechanism);
  const ledger = createModelUsageLedger({ maxCalls: budget.llmCallBudget });
  const port = createReferenceModelPort({
    // requireModelConfig already validated the credential above; the one
    // reader (readModelCredential) is called again here so the value sent is
    // the value that was validated.
    apiKey: readModelCredential(env) as string,
    modelId: config.modelId,
    ledger,
  });

  return {
    generate_hypotheses: createModelGenerateHypotheses({ port, mechanisms }),
    interpret_residual_evidence: createModelInterpretResidualEvidence({ port }),
    challenge_hypothesis: createModelChallengeHypothesis({ port, mechanisms }),
    propose_conclusion: createModelProposeConclusion({ port, mechanisms }),
  };
}

/**
 * A minimal, manual `--flag value` reader — the same shape
 * `apps/cli/src/commands/dev-spike.ts`'s own `option()` uses, deliberately
 * not `node:util`'s `parseArgs`: with other, undeclared flags present in the
 * same argv, `parseArgs`'s non-strict inference of which token is a value and
 * which is the next flag is exactly the ambiguity this reads around by
 * indexing the raw argv directly.
 */
function option(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(`--${flag}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${flag} requires a value`);
  }
  return value;
}

export async function runInvestigate(args: readonly string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${investigateHelp}\n`);
    return;
  }

  const replayPath = option(args, 'replay');
  if (replayPath === undefined) {
    throw new Error('--replay is required: aic investigate --replay <file>');
  }

  const rolesOption = option(args, 'roles') ?? 'model';
  if (rolesOption !== 'model' && rolesOption !== 'scripted') {
    throw new Error(`--roles must be "model" or "scripted", got ${JSON.stringify(rolesOption)}`);
  }

  const runId = option(args, 'run-id') ?? randomUUID();

  const content = parseReplayFileContent(readReplayFile(replayPath));

  // Resolved and validated before anything else the model arm needs, so a
  // missing credential fails before the replay file's fixture is even
  // touched for the graph's own purposes — no network reached either way.
  const reasoning: InvestigationReasoning =
    rolesOption === 'model'
      ? buildModelReasoning(process.env, content.budget)
      : createScriptedReasoning({ runId, fixture: content.fixture });

  const nodes = createInvestigationNodes({
    reasoning,
    execute: createPlannedReplayExecutor({
      fixture: content.fixture,
      routes: INVESTIGATION_ROUTES,
      // The replay file's fixture already carries every evidence item's own
      // inline `observation`; the CLI reads no separate annotation table, so
      // this callback answers nothing new for any item.
      annotate: () => undefined,
    }).execute,
    asOf: () => content.asOf,
  });

  const graph = createInvestigationGraph({ nodes });
  const finalState = await graph.execute({
    kind: 'start',
    state: buildInitialState(runId, content),
  });

  const hypotheses = finalState.hypotheses.map((hypothesis) => ({
    id: hypothesis.id,
    status: deriveHypothesisStatus({
      hypothesisId: hypothesis.id,
      predictions: finalState.predictions,
      assessments: finalState.assessments,
      evidence: finalState.evidence,
      rulesVersion: finalState.control.statusRulesVersion,
    }),
  }));

  process.stdout.write(
    `${JSON.stringify({
      runId,
      stopKind: finalState.control.stopKind ?? null,
      trials: finalState.trials.length,
      evidence: finalState.evidence.map((item) => item.id),
      hypotheses,
      conclusion: finalState.conclusion ?? null,
    })}\n`,
  );
}
