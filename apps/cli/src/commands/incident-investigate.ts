import { createHash } from 'node:crypto';

import {
  createBoundInvestigationExecutor,
  type BoundInvestigationExecutorConstructionResult,
  type CreateBoundInvestigationExecutorOptions,
  type ResolveSecretResult,
} from '@aic/tools';
import {
  type CommittedExecution,
  type Incident,
  type IncidentState,
  type IntakeDerivedIncident,
  type RegistrySnapshot,
} from '@aic/domain';
import { createInvestigationGraph, createInvestigationNodes } from '@aic/graph';
import { resolveTracingConfig } from '@aic/observability';
import {
  createModelUsageLedger,
  createReferenceModelPort,
  readModelCredential,
  requireModelConfig,
  type ModelPort,
} from '@aic/roles';
import type { RunClaim, RunRecord } from '@aic/persistence';

import { resolveIncidentScope } from './incident.js';
import { buildInitialState, createModelReasoning } from './investigate.js';
import { summarizeInvestigation } from './investigation-summary.js';

/**
 * AIC-146 sub-slice c4b: `aic incident investigate <service> <env>
 * <incident-id> --roles model|scripted [--run-id <id>]` — the same canonical
 * composition `aic investigate` (`investigate.ts`) runs, over a durable run
 * (`@aic/persistence`) instead of a replay file. See
 * test/cli-incident-investigate.test.mjs's own header for the full pinned
 * `deps`/refusal contract this module is built against.
 */

export type IncidentInvestigateRefusalReason =
  | 'invalid-arguments'
  | 'invalid-roles'
  | 'unknown-service'
  | 'unknown-environment'
  | 'environment-of-another-service'
  | 'unknown-incident'
  | 'incident-scope-mismatch'
  | 'no-source-bindings'
  | 'source-bindings-refused'
  | 'run-input-mismatch'
  | 'run-failed'
  | 'run-waiting-human'
  | 'run-held'
  | 'checkpointer-not-provisioned'
  | 'scripted-roles-unavailable';

const REFUSAL_MESSAGES: Readonly<Record<IncidentInvestigateRefusalReason, string>> = {
  'invalid-arguments':
    'usage: aic incident investigate <service> <env> <incident-id> --roles model|scripted [--run-id <id>]',
  'invalid-roles': '--roles must be "model" or "scripted"',
  'unknown-service': 'unknown service',
  'unknown-environment': 'unknown environment',
  'environment-of-another-service': 'that environment belongs to a different service',
  'unknown-incident': 'unknown incident',
  'incident-scope-mismatch': "the incident's own primary scope disagrees with the resolved <service>/<env>",
  'no-source-bindings': "the incident's Environment has no SourceBindings to investigate over",
  'source-bindings-refused': 'the investigation port refused construction',
  'run-input-mismatch':
    'an existing run under this id disagrees on incident, scope or roles, or its stored input is not one this command reads',
  'run-failed': 'this run has already failed',
  'run-waiting-human': 'this run is waiting on a human decision',
  'run-held': 'this run is currently claimed by another worker',
  'checkpointer-not-provisioned': 'the LangGraph checkpointer schema is not provisioned in this database',
  'scripted-roles-unavailable':
    '--roles scripted has no request vocabulary for a live incident investigation yet',
};

/**
 * A closed reason, a fixed message per reason (never argv), and — per
 * `source-bindings-refused` — at most a UUID or a closed ToolId named beside
 * it, never anything else.
 */
export class IncidentInvestigateRefusal extends Error {
  readonly reason: IncidentInvestigateRefusalReason;

  constructor(reason: IncidentInvestigateRefusalReason, message: string = REFUSAL_MESSAGES[reason]) {
    super(message);
    this.name = 'IncidentInvestigateRefusal';
    this.reason = reason;
  }
}

/**
 * What `deps.createCheckpointer` throws when the database has no checkpointer
 * schema at all. It is the only failure mapped to `checkpointer-not-provisioned`;
 * any other failure (a version mismatch, a connection error) propagates as it
 * is — see cli-incident-investigate.test.mjs › "any other createCheckpointer
 * failure propagates unchanged rather than being reported as not provisioned".
 */
export class CheckpointerNotProvisionedError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('the checkpointer schema is not provisioned', options);
    this.name = 'CheckpointerNotProvisionedError';
  }
}

/**
 * The write context every commit and the checkpointer's fence go through —
 * structurally `@aic/persistence`'s own `RunWriteContext`. `assertOwner` is
 * declared here (never called by this module itself) only so the checkpointer
 * wiring (`apps/cli/src/index.ts`) can pass this same object on as a
 * `CheckpointFence` without a second, narrower type.
 */
export interface IncidentInvestigateWriteContext extends CommittedExecution {
  complete(reason?: string): Promise<void>;
  assertOwner(kind?: string): Promise<void>;
}

/** Derived from `createInvestigationGraph`'s own parameter type rather than a second import of `BaseCheckpointSaver` (`.claude/rules/invariants.md`, "one mechanism, one implementation"). */
type InvestigationCheckpointer = NonNullable<Parameters<typeof createInvestigationGraph>[0]['checkpointer']>;

export interface IncidentInvestigateDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly registry: { snapshot(): Promise<RegistrySnapshot> };
  readonly incidents: { getIncident(incidentId: string): Promise<IntakeDerivedIncident | null> };
  readonly runs: {
    getRun(runId: string): Promise<RunRecord | null>;
    createRun(run: { runId: string; input: unknown }): Promise<void>;
    claimRun(runId: string, workerId: string): Promise<RunClaim | null>;
    sweepExpired(): Promise<string[]>;
    renewLease(claim: RunClaim): Promise<boolean>;
  };
  readonly openWriteContext: (claim: RunClaim) => IncidentInvestigateWriteContext;
  readonly createCheckpointer: (
    context?: IncidentInvestigateWriteContext,
  ) => Promise<InvestigationCheckpointer> | InvestigationCheckpointer;
  readonly fetch: typeof fetch;
  readonly resolveSecret: (secretName: string) => Promise<ResolveSecretResult>;
  readonly createExecutor?: typeof createBoundInvestigationExecutor;
  readonly createModelPort?: typeof createReferenceModelPort;
  readonly stdout: (text: string) => void;
  readonly now: () => string;
  readonly workerId: string;
}

interface IncidentInvestigateBudget {
  readonly maxIterations: number;
  readonly llmCallBudget: number;
  readonly reservedChallengeBudget: number;
}

/**
 * A CLI constant — `aic investigate` has no default of its own (its budget
 * always comes from the named `--replay` file), so this is this command's own
 * considered starting point rather than one restated from elsewhere.
 * [inferred; the owner may want this exposed as a flag later]
 */
const DEFAULT_BUDGET: IncidentInvestigateBudget = Object.freeze({
  maxIterations: 4,
  llmCallBudget: 8,
  reservedChallengeBudget: 2,
});

/** `renewLease` cadence: a third of the lease `apps/cli/src/index.ts` wires the run store with, so a single missed tick never lets the lease expire. */
export const HEARTBEAT_INTERVAL_MS = 20_000;

interface StoredRunInput {
  readonly kind: 'incident-investigation';
  readonly v: 1;
  readonly incidentId: string;
  readonly serviceId: string;
  readonly environmentId: string;
  readonly roles: 'model' | 'scripted';
  readonly asOf: string;
  readonly budget: IncidentInvestigateBudget;
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function asStoredRunInput(value: unknown): StoredRunInput | undefined {
  const record = ownRecord(value);
  if (record === undefined) return undefined;
  const budget = ownRecord(record.budget);
  if (
    record.kind !== 'incident-investigation' ||
    record.v !== 1 ||
    typeof record.incidentId !== 'string' ||
    typeof record.serviceId !== 'string' ||
    typeof record.environmentId !== 'string' ||
    (record.roles !== 'model' && record.roles !== 'scripted') ||
    typeof record.asOf !== 'string' ||
    budget === undefined ||
    !isCount(budget.maxIterations) ||
    !isCount(budget.llmCallBudget) ||
    !isCount(budget.reservedChallengeBudget)
  ) {
    return undefined;
  }
  return record as unknown as StoredRunInput;
}

interface ParsedIncidentInvestigateArgv {
  readonly service: string;
  readonly env: string;
  readonly incidentId: string;
  readonly roles: 'model' | 'scripted';
  readonly runId: string | undefined;
}

/**
 * A minimal, manual reader — deliberately not `node:util`'s `parseArgs`, the
 * same reason `investigate.ts`'s own `option()` gives: an undeclared flag
 * here must be refused as `invalid-arguments`, not silently read as a bare
 * positional.
 */
function parseArgv(argv: readonly string[]): ParsedIncidentInvestigateArgv {
  const positionals: string[] = [];
  let rolesValue: string | undefined;
  let runId: string | undefined;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === '--roles') {
      const value = argv[index + 1];
      if (value === undefined) throw new IncidentInvestigateRefusal('invalid-arguments');
      rolesValue = value;
      index += 2;
      continue;
    }
    if (token === '--run-id') {
      const value = argv[index + 1];
      if (value === undefined) throw new IncidentInvestigateRefusal('invalid-arguments');
      runId = value;
      index += 2;
      continue;
    }
    if (token.startsWith('--')) {
      throw new IncidentInvestigateRefusal('invalid-arguments');
    }
    positionals.push(token);
    index += 1;
  }
  if (positionals.length !== 3) {
    throw new IncidentInvestigateRefusal('invalid-arguments');
  }
  if (rolesValue === undefined) {
    throw new IncidentInvestigateRefusal('invalid-roles');
  }
  if (rolesValue !== 'model' && rolesValue !== 'scripted') {
    throw new IncidentInvestigateRefusal('invalid-roles');
  }
  const [service, env, incidentId] = positionals;
  return { service, env, incidentId, roles: rolesValue, runId };
}

/** Independent of `@aic/persistence`'s own run identity: hand-computed here, and re-derived independently by the test's own `defaultRunIdFor`. */
function defaultRunIdFor(incidentId: string): string {
  const hash = createHash('sha256').update(JSON.stringify(['aic.incident-run', 1, incidentId])).digest('hex');
  return `incident-run-${hash.slice(0, 32)}`;
}

function describeSourceBindingsRefusal(
  result: Extract<BoundInvestigationExecutorConstructionResult, { ok: false }>,
): string {
  const parts = [`the investigation port refused construction: ${result.reason}`];
  if (result.sourceBindingId !== undefined) parts.push(`sourceBindingId=${result.sourceBindingId}`);
  if (result.tool !== undefined) parts.push(`tool=${result.tool}`);
  if (result.sourceBindingIds !== undefined) parts.push(`sourceBindingIds=[${result.sourceBindingIds.join(', ')}]`);
  return parts.join(' ');
}

function hasOwnControlChannel(values: unknown): boolean {
  return typeof values === 'object' && values !== null && Object.hasOwn(values, 'control');
}

async function buildCheckpointer(
  deps: IncidentInvestigateDeps,
  context?: IncidentInvestigateWriteContext,
): Promise<InvestigationCheckpointer> {
  try {
    return await deps.createCheckpointer(context);
  } catch (error) {
    if (error instanceof CheckpointerNotProvisionedError) {
      throw new IncidentInvestigateRefusal('checkpointer-not-provisioned');
    }
    throw error;
  }
}

/**
 * The same four primitives `investigate.ts`'s own (private) model-port
 * builder composes — `requireModelConfig`, `createModelUsageLedger`,
 * `readModelCredential`, `createReferenceModelPort` — all already exported
 * from `@aic/roles`, so this reuses the public seam rather than a copy of
 * that private helper.
 */
function buildModelPort(deps: IncidentInvestigateDeps, budget: IncidentInvestigateBudget): ModelPort {
  const config = requireModelConfig(deps.env);
  const ledger = createModelUsageLedger({ maxCalls: budget.llmCallBudget });
  const createModelPort = deps.createModelPort ?? createReferenceModelPort;
  return createModelPort({
    apiKey: readModelCredential(deps.env) as string,
    modelId: config.modelId,
    ledger,
  });
}

export async function runIncidentInvestigateCommand(
  argv: readonly string[],
  deps: IncidentInvestigateDeps,
): Promise<void> {
  const parsed = parseArgv(argv);

  if (parsed.roles === 'scripted') {
    // AIC-146 design D1: no owner-approved request vocabulary yet for a
    // scripted probe against live SourceBindings.
    throw new IncidentInvestigateRefusal('scripted-roles-unavailable');
  }

  // Validated before any store read (design step 2) — never before argv
  // parsing above, which must refuse invalid-arguments/invalid-roles first.
  requireModelConfig(deps.env);

  // Decided from the real process.env, which @langchain/core reads, before
  // any store is read. see cli-incident-investigate.test.mjs › "refuses
  // tracing enabled in process.env with no LangSmith key, naming
  // LANGSMITH_API_KEY, before the registry is read"
  const tracing = resolveTracingConfig(process.env);
  if (tracing.enabled) {
    process.env.LANGCHAIN_CALLBACKS_BACKGROUND ??= 'false';
  }

  const registry = await deps.registry.snapshot();
  const scope = resolveIncidentScope(registry, parsed.service, parsed.env);
  if (!scope.ok) {
    throw new IncidentInvestigateRefusal(scope.reason);
  }

  const incident = await deps.incidents.getIncident(parsed.incidentId);
  if (incident === null) {
    throw new IncidentInvestigateRefusal('unknown-incident');
  }
  if (
    incident.primaryScope.serviceId !== scope.serviceId ||
    incident.primaryScope.environmentId !== scope.environmentId
  ) {
    throw new IncidentInvestigateRefusal('incident-scope-mismatch');
  }

  const environmentId = incident.primaryScope.environmentId;
  const bindings = registry.sourceBindings.filter((binding) => binding.environmentId === environmentId);
  const credentialRefs = registry.credentialRefs.filter((ref) => ref.environmentId === environmentId);
  if (bindings.length === 0) {
    throw new IncidentInvestigateRefusal('no-source-bindings');
  }

  const createExecutor = deps.createExecutor ?? createBoundInvestigationExecutor;
  const executorOptions: CreateBoundInvestigationExecutorOptions = {
    bindings,
    credentialRefs,
    mode: 'live',
    clock: () => new Date(deps.now()),
    fetch: deps.fetch,
    resolveSecret: deps.resolveSecret,
  };
  const executorResult = await createExecutor(executorOptions);
  if (!executorResult.ok) {
    throw new IncidentInvestigateRefusal('source-bindings-refused', describeSourceBindingsRefusal(executorResult));
  }
  const executor = executorResult.executor;

  const runId = parsed.runId ?? defaultRunIdFor(parsed.incidentId);
  const existingRun = await deps.runs.getRun(runId);

  let asOf: string;
  let budget: IncidentInvestigateBudget;

  if (existingRun === null) {
    asOf = deps.now();
    budget = DEFAULT_BUDGET;
    const input: StoredRunInput = {
      kind: 'incident-investigation',
      v: 1,
      incidentId: parsed.incidentId,
      serviceId: scope.serviceId,
      environmentId: scope.environmentId,
      roles: parsed.roles,
      asOf,
      budget,
    };
    await deps.runs.createRun({ runId, input });
  } else {
    const storedInput = asStoredRunInput(existingRun.input);
    const mismatched =
      storedInput === undefined ||
      storedInput.incidentId !== parsed.incidentId ||
      storedInput.serviceId !== scope.serviceId ||
      storedInput.environmentId !== scope.environmentId ||
      storedInput.roles !== parsed.roles;
    if (mismatched) {
      throw new IncidentInvestigateRefusal('run-input-mismatch');
    }
    asOf = storedInput.asOf;
    budget = storedInput.budget;

    if (existingRun.status === 'completed') {
      // Read-only: the checkpointer is built with no write context at all
      // (deps.createCheckpointer's own contract), and the graph is only ever
      // asked for its state, never invoked.
      const checkpointer = await buildCheckpointer(deps);
      const reasoning = createModelReasoning(buildModelPort(deps, budget));
      const nodes = createInvestigationNodes({
        reasoning,
        execute: executor.execute,
        asOf: () => asOf,
        evidenceProvenance: 'required',
      });
      const graph = createInvestigationGraph({ nodes, checkpointer });
      const snapshot = await graph.getState({ threadId: runId });
      const finalState = snapshot.values as IncidentState;
      deps.stdout(JSON.stringify(summarizeInvestigation(runId, finalState)));
      return;
    }
    if (existingRun.status === 'failed') {
      throw new IncidentInvestigateRefusal('run-failed');
    }
    if (existingRun.status === 'waiting_human') {
      throw new IncidentInvestigateRefusal('run-waiting-human');
    }
    if (existingRun.status === 'running') {
      const requeued = await deps.runs.sweepExpired();
      if (!requeued.includes(runId)) {
        throw new IncidentInvestigateRefusal('run-held');
      }
    }
    // 'queued', or 'running' with an expired lease just requeued: fall
    // through to claim it below.
  }

  const claim = await deps.runs.claimRun(runId, deps.workerId);
  if (claim === null) {
    // claimRun also returns null when this very call exhausted the run's
    // attempts and moved it to failed; re-read to say which.
    const after = await deps.runs.getRun(runId);
    throw new IncidentInvestigateRefusal(after?.status === 'failed' ? 'run-failed' : 'run-held');
  }

  const context = deps.openWriteContext(claim);
  const heartbeat = setInterval(() => {
    void deps.runs.renewLease(claim).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  try {
    const checkpointer = await buildCheckpointer(deps, context);
    const modelPort = buildModelPort(deps, budget);
    const reasoning = createModelReasoning(modelPort, context);
    const nodes = createInvestigationNodes({
      reasoning,
      execute: executor.execute,
      asOf: () => asOf,
      evidenceProvenance: 'required',
      execution: context,
    });
    const graph = createInvestigationGraph({ nodes, checkpointer });

    const snapshot = await graph.getState({ threadId: runId });
    const finalState = hasOwnControlChannel(snapshot.values)
      ? await graph.execute({ kind: 'continue' }, { threadId: runId })
      : await graph.execute(
          // `IntakeDerivedIncident` carries no index signature of its own;
          // `IncidentSchema` is a `looseObject`, which the `kind: 'start'`
          // boundary parses the incident against before any node runs.
          { kind: 'start', state: buildInitialState(runId, { incident: incident as unknown as Incident, budget }) },
          { threadId: runId },
        );

    await context.complete(finalState.control.stopKind);
    deps.stdout(JSON.stringify(summarizeInvestigation(runId, finalState)));
  } finally {
    clearInterval(heartbeat);
  }
}
