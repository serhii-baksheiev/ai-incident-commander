import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  deriveHypothesisStatus,
  IncidentSchema,
  INCIDENT_STATE_SCHEMA_VERSION,
  LogicalCountSchema,
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
import { resolveTracingConfig } from '@aic/observability';
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
  type ModelPort,
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
export const investigateHelp = `Usage: aic investigate --replay <file> --roles model|scripted [--run-id <id>]

Options:
  --replay   Path to a replay file: { asOf, incident, budget, fixture }
  --roles    "model" or "scripted" (required)
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

const BUDGET_FIELDS = ['maxIterations', 'llmCallBudget', 'reservedChallengeBudget'] as const;

/**
 * Validated against the domain's own `LogicalCountSchema`
 * (`z.number().int().nonnegative()`) — never a hand-written positive-integer
 * check, which disagreed with it: `reservedChallengeBudget: 0` is a value
 * `IncidentStateControlSchema` accepts (and the kernel runs), so the CLI must
 * accept it too. One spelling of the fact (`.claude/rules/invariants.md`,
 * "one mechanism, one implementation") — the same schema
 * `packages/evals/src/budget-policy.ts` imports for exactly this reason.
 * see cli-investigate.test.mjs › "a --replay file whose budget field is
 * negative, non-integer or not a number is refused for each of the three
 * fields, exits non-zero, writes nothing to stdout, and names the field on
 * stderr"
 */
function parseBudget(value: unknown): ReplayBudget {
  const record = ownRecord(value);
  if (record === undefined) {
    throw new Error('--replay file is missing required field budget');
  }
  const parsed: Record<string, number> = {};
  for (const field of BUDGET_FIELDS) {
    const candidate = record[field];
    const result = LogicalCountSchema.safeParse(candidate);
    if (!result.success) {
      throw new Error(
        `--replay file budget.${field} must be a non-negative integer, got ${JSON.stringify(candidate)}`,
      );
    }
    parsed[field] = result.data;
  }
  return parsed as unknown as ReplayBudget;
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

function parseFixture(value: unknown): PlannedReplayScenarioFixture {
  const record = ownRecord(value);
  if (record === undefined) {
    throw new Error('--replay file is missing required field fixture');
  }
  if (typeof record.version !== 'number') {
    throw new Error(`--replay file fixture.version must be a number, got ${JSON.stringify(record.version)}`);
  }
  if (!Array.isArray(record.entries) || record.entries.length === 0) {
    throw new Error('--replay file fixture.entries must be a non-empty array');
  }
  record.entries.forEach((entry: unknown, index: number) => {
    const entryRecord = ownRecord(entry);
    if (entryRecord === undefined) {
      throw new Error(`--replay file fixture.entries[${index}] must be an object`);
    }
    if (typeof entryRecord.toolId !== 'string') {
      throw new Error(`--replay file fixture.entries[${index}] is missing required string field toolId`);
    }
  });
  return record as unknown as PlannedReplayScenarioFixture;
}

function parseReplayFileContent(raw: unknown): ReplayFileContent {
  const record = ownRecord(raw);
  if (record === undefined) {
    throw new Error('--replay file must contain a JSON object');
  }
  const asOf = parseAsOf(record.asOf);
  const budget = parseBudget(record.budget);
  const incidentResult = IncidentSchema.safeParse(record.incident);
  if (!incidentResult.success) {
    throw new Error(`--replay file incident is invalid: ${incidentResult.error.message}`);
  }
  const fixture = parseFixture(record.fixture);
  return {
    asOf,
    incident: incidentResult.data,
    budget,
    fixture,
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
 * are pinned equal elsewhere: prediction-nodes.test.mjs ›
 * "PREDICTION_TEMPLATES.byMechanism carries exactly one key per
 * ROOT_CAUSE_MECHANISMS entry, in both directions".
 *
 * Takes the already-constructed port, so a test can wire a fake one directly
 * — the same seam `scripts/lane-arms.mjs`'s `modelNodes(record, port)` uses.
 * see cli-investigate.test.mjs › "createModelReasoning(fakePort) wires
 * generate_hypotheses, challenge_hypothesis and propose_conclusion as model
 * roles carrying the PREDICTION_TEMPLATES mechanism vocabulary, which equals
 * evals.ROOT_CAUSE_MECHANISMS as a set"
 */
export function createModelReasoning(port: ModelPort): InvestigationReasoning {
  const mechanisms = Object.keys(PREDICTION_TEMPLATES.byMechanism);
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

export interface RunInvestigateDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly createModelPort?: typeof createReferenceModelPort;
}

/**
 * Resolves and validates the credential once, then hands the SAME validated
 * value to the port factory — `requireModelConfig` throws
 * `MissingModelCredentialError`, naming the missing variable, before the
 * factory (or any network) is ever reached.
 * see cli-investigate.test.mjs › "runInvestigate with --replay, --roles model
 * and injected env and createModelPort calls the injected factory once with
 * the env credential, and the fake port it returns sees at least one call
 * before the run ends"
 */
function buildModelPort(
  env: NodeJS.ProcessEnv,
  budget: ReplayBudget,
  createModelPort: typeof createReferenceModelPort,
): ModelPort {
  const config = requireModelConfig(env);
  const ledger = createModelUsageLedger({ maxCalls: budget.llmCallBudget });
  return createModelPort({
    apiKey: readModelCredential(env) as string,
    modelId: config.modelId,
    ledger,
  });
}

export async function runInvestigate(
  args: readonly string[],
  deps: RunInvestigateDeps = {},
): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${investigateHelp}\n`);
    return;
  }

  const env = deps.env ?? process.env;
  const createModelPort = deps.createModelPort ?? createReferenceModelPort;

  const replayPath = option(args, 'replay');
  if (replayPath === undefined) {
    throw new Error('--replay is required: aic investigate --replay <file> --roles model|scripted');
  }

  const rolesOption = option(args, 'roles');
  if (rolesOption === undefined) {
    throw new Error('--roles is required: aic investigate --replay <file> --roles model|scripted');
  }
  if (rolesOption !== 'model' && rolesOption !== 'scripted') {
    throw new Error(`--roles must be "model" or "scripted", got ${JSON.stringify(rolesOption)}`);
  }

  const runId = option(args, 'run-id') ?? randomUUID();

  // Resolved before any other work — including reading the replay file's
  // content into the graph — the same way `aic dev spike` decides tracing
  // before it starts: tracing that was asked for and cannot be delivered
  // must stop the run, not silently drop the trace partway through it.
  const tracing = resolveTracingConfig(env);
  if (tracing.enabled) {
    // This process exits as soon as it has printed its result. The tracer's
    // default is to send in the background, which drops whatever has not
    // left by then; `false` makes @langchain/core block on finalization
    // (see dev-spike.ts for the same handling).
    process.env.LANGCHAIN_CALLBACKS_BACKGROUND ??= 'false';
  }

  const content = parseReplayFileContent(readReplayFile(replayPath));

  // `buildModelPort` validates the credential before the factory (or any
  // network) is reached, so a missing credential still fails before any
  // graph node runs.
  const reasoning: InvestigationReasoning =
    rolesOption === 'model'
      ? createModelReasoning(buildModelPort(env, content.budget, createModelPort))
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
