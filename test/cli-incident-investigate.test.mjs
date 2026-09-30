/**
 * AIC-146 sub-slice c4b: `aic incident investigate <service> <env>
 * <incident-id> --roles scripted|model [--run-id <id>]` — the new module
 * `apps/cli/src/commands/incident-investigate.ts`, exporting
 * `runIncidentInvestigateCommand(argv, deps): Promise<void>` and a refusal
 * class `IncidentInvestigateRefusal` (a closed `.reason`). No database here:
 * every `deps` field is a fake or an in-repo real piece, recording every
 * call, following `test/cli-incident-command.test.mjs`'s own convention.
 * Spawned, no-database dispatch rows (missing positionals, missing/invalid
 * `--roles`, `--roles model` with no credential, the connection-variable
 * boundary, and the unknown-subcommand help text) live in
 * `test/cli-dispatcher.test.mjs`, matching where every other onboarding
 * command's own spawned rows already live.
 *
 * ## The deps interface this file pins (Green implements to it)
 *
 *   interface IncidentInvestigateDeps {
 *     env: NodeJS.ProcessEnv;
 *     registry: { snapshot(): Promise<RegistrySnapshot> };
 *     incidents: { getIncident(incidentId: string): Promise<IntakeDerivedIncident | null> };
 *     runs: {
 *       getRun(runId: string): Promise<RunRecord | null>;
 *       createRun(run: { runId: string; input: unknown }): Promise<void>;
 *       claimRun(runId: string, workerId: string): Promise<RunClaim | null>;
 *       sweepExpired(): Promise<string[]>;
 *       renewLease(claim: RunClaim): Promise<boolean>;
 *     };
 *     // Returns a CommittedExecution (`.committed(execKey, compute, options?)`)
 *     // plus `.complete(reason?): Promise<void>`, mirroring
 *     // `@aic/persistence`'s own `RunWriteContext` shape structurally.
 *     openWriteContext(claim: RunClaim): CommittedExecutionLike;
 *     // Called with the write context on every path but the read-only
 *     // "already completed" one, where it is called with no argument at all
 *     // — production wiring decides whether/how to fence; this command does
 *     // not import `createFencedCheckpointer` itself. A throw (e.g. a real
 *     // "relation does not exist" from an unprovisioned checkpointer schema)
 *     // is mapped to `checkpointer-not-provisioned`.
 *     createCheckpointer(context?: CommittedExecutionLike): Promise<BaseCheckpointSaver> | BaseCheckpointSaver;
 *     fetch: typeof fetch;
 *     resolveSecret(secretName: string): Promise<ResolveSecretResult>;
 *     // Optional seams, mirroring `investigate.ts`'s own `RunInvestigateDeps.createModelPort`:
 *     createExecutor?: typeof createBoundInvestigationExecutor; // default: the real @aic/tools export
 *     createModelPort?: typeof createReferenceModelPort;        // default: the real @aic/roles export
 *     stdout(text: string): void;
 *     now(): string; // ISO instant; called once at fresh-run creation for
 *                     // `asOf`, and (only if the executor's `execute()` ever
 *                     // actually runs) to build its `clock`. Never called
 *                     // again on an existing run: `asOf` is read from
 *                     // `runs.input.asOf` instead.
 *     workerId: string;
 *   }
 *
 *   export type IncidentInvestigateRefusalReason =
 *     | 'invalid-arguments' | 'invalid-roles' | 'unknown-service'
 *     | 'unknown-environment' | 'environment-of-another-service'
 *     | 'unknown-incident' | 'incident-scope-mismatch' | 'no-source-bindings'
 *     | 'source-bindings-refused' | 'run-input-mismatch' | 'run-failed'
 *     | 'run-waiting-human' | 'run-held' | 'checkpointer-not-provisioned';
 *
 *   export class IncidentInvestigateRefusal extends Error {
 *     readonly reason: IncidentInvestigateRefusalReason;
 *   }
 *
 * `runs.input` this command stores on a fresh run:
 *   { kind: 'incident-investigation', v: 1, incidentId, serviceId,
 *     environmentId, roles, asOf, budget: { maxIterations, llmCallBudget,
 *     reservedChallengeBudget } }
 *
 * Default `runId` is `'incident-run-' + sha256(JSON.stringify(['aic.incident-run',
 * 1, incidentId])).slice(0, 32)`, hand-computed independently below by
 * `defaultRunIdFor`; `--run-id` overrides it.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import * as domain from '@aic/domain';
import { createInvestigationGraph, createInvestigationNodes } from '@aic/graph';
import { createBoundInvestigationExecutor } from '@aic/tools';
import { MemorySaver } from '@langchain/langgraph';

import { createFakeCommittedExecution } from './fixtures/fake-committed-execution.mjs';

function loadIncidentInvestigateCommand() {
  return import('../apps/cli/dist/commands/incident-investigate.js');
}

function loadInvestigateCommand() {
  return import('../apps/cli/dist/commands/investigate.js');
}

function loadInvestigationSummary() {
  return import('../apps/cli/dist/commands/investigation-summary.js');
}

/* -------------------------------------------------------------------------- */
/* Independent oracle: the default run id                                     */
/* -------------------------------------------------------------------------- */

function defaultRunIdFor(incidentId) {
  const hash = createHash('sha256')
    .update(JSON.stringify(['aic.incident-run', 1, incidentId]))
    .digest('hex');
  return `incident-run-${hash.slice(0, 32)}`;
}

/* -------------------------------------------------------------------------- */
/* Fixtures: a two-Service, two-Environment registry (one Service has TWO     */
/* Environments, to prove cross-environment binding exclusion)                */
/* -------------------------------------------------------------------------- */

const FIXED_NOW = '2026-09-30T12:00:00.000Z';
const WORKER_ID = 'worker-c4b-test-1';

const serviceCheckoutId = randomUUID();
const environmentStagingId = randomUUID(); // the target environment
const environmentProdId = randomUUID(); // another environment of the SAME service
const serviceBillingId = randomUUID();
const environmentBillingStagingId = randomUUID();

function registrySnapshot({ sourceBindings = [], credentialRefs = [] } = {}) {
  return {
    services: [
      { id: serviceCheckoutId, name: 'checkout', repositoryAliases: [] },
      { id: serviceBillingId, name: 'billing', repositoryAliases: [] },
    ],
    environments: [
      { id: environmentStagingId, serviceId: serviceCheckoutId, name: 'staging' },
      { id: environmentProdId, serviceId: serviceCheckoutId, name: 'prod' },
      { id: environmentBillingStagingId, serviceId: serviceBillingId, name: 'staging' },
    ],
    sourceBindings,
    credentialRefs,
    actionPolicies: [],
  };
}

function labBinding({ environmentId, name = 'lab-primary', id = randomUUID() }) {
  return domain.SourceBindingSchema.parse({
    id,
    environmentId,
    adapterId: 'lab',
    adapterVersion: '1',
    name,
    config: { baseUrl: 'http://127.0.0.1:9' },
    credentialRefId: null,
  });
}

function intakeDerivedIncident({ id, serviceId, environmentId }) {
  return {
    id,
    primaryScope: { serviceId, environmentId },
    title: 'checkout error spike',
    startedAt: FIXED_NOW,
    signals: [],
    idempotencyKey: `idempotency-${id}`,
  };
}

/** A github-pat SHAPE, assembled at runtime — never a literal (`.claude/rules/autonomy.md`). */
const pastedSecret = () => ['ghp', 'B'.repeat(28)].join('_');

/** A credential SHAPE, assembled at runtime, mirroring cli-investigate.test.mjs's own `fakeApiKey`. */
function fakeAnthropicKey() {
  return ['sk', 'ant', 'test', '9'.repeat(24)].join('-');
}

/* -------------------------------------------------------------------------- */
/* Fake deps factory                                                          */
/* -------------------------------------------------------------------------- */

function baseDeps(overrides = {}) {
  const calls = {
    snapshot: [],
    getIncident: [],
    getRun: [],
    createRun: [],
    claimRun: [],
    sweepExpired: [],
    renewLease: [],
    openWriteContext: [],
    createCheckpointer: [],
    resolveSecret: [],
    fetch: [],
    now: [],
  };
  const stdoutLines = [];
  const writeContexts = [];

  const defaultRuns = {
    getRun: async (runId) => {
      calls.getRun.push(runId);
      return null;
    },
    createRun: async (run) => {
      calls.createRun.push(run);
    },
    claimRun: async (runId, workerId) => {
      calls.claimRun.push({ runId, workerId });
      return { runId, ownerWorkerId: workerId, executionAttempt: 1 };
    },
    sweepExpired: async () => {
      calls.sweepExpired.push(true);
      return [];
    },
    renewLease: async (claim) => {
      calls.renewLease.push(claim);
      return true;
    },
  };

  const { runs: runsOverrides, ...rest } = overrides;

  const deps = {
    env: { ANTHROPIC_API_KEY: fakeAnthropicKey() },
    registry: {
      snapshot: async () => {
        calls.snapshot.push(true);
        return registrySnapshot();
      },
    },
    incidents: {
      getIncident: async (id) => {
        calls.getIncident.push(id);
        return null;
      },
    },
    runs: { ...defaultRuns, ...runsOverrides },
    openWriteContext: (claim) => {
      calls.openWriteContext.push(claim);
      const execution = createFakeCommittedExecution();
      const context = {
        ...execution,
        completeCalls: [],
        async complete(reason) {
          context.completeCalls.push(reason);
        },
      };
      writeContexts.push(context);
      return context;
    },
    createCheckpointer: async (context) => {
      calls.createCheckpointer.push(context);
      return new MemorySaver();
    },
    fetch: async () => {
      throw new Error('FAKE_FETCH_MUST_NOT_BE_CALLED_IN_THIS_ROW');
    },
    resolveSecret: async (secretName) => {
      calls.resolveSecret.push(secretName);
      return { status: 'absent' };
    },
    stdout: (text) => stdoutLines.push(text),
    now: () => {
      calls.now.push(true);
      return FIXED_NOW;
    },
    workerId: WORKER_ID,
    ...rest,
  };

  return { deps, calls, stdoutLines, writeContexts };
}

function argvFor({ service = 'checkout', env = 'staging', incidentId, roles = 'model', runId } = {}) {
  const argv = [service, env, incidentId, '--roles', roles];
  if (runId !== undefined) argv.push('--run-id', runId);
  return argv;
}

/** A model port that throws on every call — proves calls reached it, never an answer. */
function throwingModelPort() {
  const calls = [];
  return {
    calls,
    async complete(request) {
      calls.push(request);
      throw new Error('FAKE_MODEL_PORT_REFUSES: this row reads whether/how the port was called');
    },
  };
}

/**
 * A model port that answers `generate_hypotheses`'s own schema validly, once,
 * with one `deployment-regression` hypothesis — the mechanism
 * `PREDICTION_TEMPLATES.byMechanism` (`@aic/graph`) registers a
 * `deployment-in-window` prediction under, which `INVESTIGATION_ROUTES` maps
 * to the `deployments` tool. Any LATER call (a different role's differently-shaped
 * schema) still throws: this fake exists to prove the FIRST commit lands, not
 * to carry a run to a real conclusion.
 */
function oneHypothesisThenThrowingModelPort() {
  const calls = [];
  return {
    calls,
    async complete(request) {
      calls.push(request);
      if (calls.length === 1) {
        return {
          text: JSON.stringify({
            hypotheses: [
              {
                id: 'h-deploy-1',
                statement: 'a deploy broke checkout',
                cause: { component: 'checkout-service', mechanism: 'deployment-regression' },
              },
            ],
          }),
          modelId: 'fake-model',
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      throw new Error('FAKE_MODEL_PORT_REFUSES_AFTER_FIRST_CALL: only the first call is answered validly');
    },
  };
}

function createModelPortFactoryFor(port) {
  const factoryCalls = [];
  const createModelPort = (options) => {
    factoryCalls.push(options);
    return port;
  };
  createModelPort.calls = factoryCalls;
  return createModelPort;
}

/* -------------------------------------------------------------------------- */
/* Refusal rows: one per closed reason (design section B, steps 1-11)         */
/* -------------------------------------------------------------------------- */

test('a missing positional (incident-id) is refused invalid-arguments, and calls no deps method at all', async () => {
  const command = await loadIncidentInvestigateCommand();
  const { deps, calls } = baseDeps({ createModelPort: createModelPortFactoryFor(throwingModelPort()) });

  const error = await assert.rejects(command.runIncidentInvestigateCommand(['checkout', 'staging'], deps));
  assert.ok(error instanceof command.IncidentInvestigateRefusal);
  assert.equal(error.reason, 'invalid-arguments');
  assert.deepEqual(calls.snapshot, []);
  assert.deepEqual(calls.getIncident, []);
  assert.deepEqual(calls.createRun, []);
});

test('an unknown flag is refused invalid-arguments, and calls no deps method at all', async () => {
  const command = await loadIncidentInvestigateCommand();
  const { deps, calls } = baseDeps({ createModelPort: createModelPortFactoryFor(throwingModelPort()) });
  const incidentId = randomUUID();

  const error = await assert.rejects(
    command.runIncidentInvestigateCommand(
      ['checkout', 'staging', incidentId, '--roles', 'model', '--bogus-flag', 'y'],
      deps,
    ),
  );
  assert.equal(error.reason, 'invalid-arguments');
  assert.deepEqual(calls.snapshot, []);
  assert.deepEqual(calls.createRun, []);
});

test('a missing --roles is refused invalid-roles, and calls no deps method at all', async () => {
  const command = await loadIncidentInvestigateCommand();
  const { deps, calls } = baseDeps({ createModelPort: createModelPortFactoryFor(throwingModelPort()) });
  const incidentId = randomUUID();

  const error = await assert.rejects(
    command.runIncidentInvestigateCommand(['checkout', 'staging', incidentId], deps),
  );
  assert.equal(error.reason, 'invalid-roles');
  assert.deepEqual(calls.snapshot, []);
  assert.deepEqual(calls.createRun, []);
});

test('--roles bogus is refused invalid-roles, and calls no deps method at all', async () => {
  const command = await loadIncidentInvestigateCommand();
  const { deps, calls } = baseDeps({ createModelPort: createModelPortFactoryFor(throwingModelPort()) });
  const incidentId = randomUUID();

  const error = await assert.rejects(
    command.runIncidentInvestigateCommand(['checkout', 'staging', incidentId, '--roles', 'bogus'], deps),
  );
  assert.equal(error.reason, 'invalid-roles');
  assert.deepEqual(calls.snapshot, []);
  assert.deepEqual(calls.createRun, []);
});

test('an unknown <service> is refused unknown-service, calls no createRun, and never echoes a secret-shaped service argument', async () => {
  const command = await loadIncidentInvestigateCommand();
  const secret = pastedSecret();
  const { deps, calls } = baseDeps({ createModelPort: createModelPortFactoryFor(throwingModelPort()) });
  const incidentId = randomUUID();

  const error = await assert.rejects(
    command.runIncidentInvestigateCommand(argvFor({ service: secret, incidentId }), deps),
  );
  assert.equal(error.reason, 'unknown-service');
  assert.ok(!error.message.includes(secret), `refusal must never echo the secret-shaped service argument: ${error.message}`);
  assert.deepEqual(calls.createRun, []);
});

test('an unknown <env> is refused unknown-environment, and calls no createRun', async () => {
  const command = await loadIncidentInvestigateCommand();
  const { deps, calls } = baseDeps({ createModelPort: createModelPortFactoryFor(throwingModelPort()) });
  const incidentId = randomUUID();

  const error = await assert.rejects(
    command.runIncidentInvestigateCommand(argvFor({ env: 'nowhere', incidentId }), deps),
  );
  assert.equal(error.reason, 'unknown-environment');
  assert.deepEqual(calls.createRun, []);
});

test('an <env> belonging to a DIFFERENT Service is refused environment-of-another-service, and calls no createRun', async () => {
  const command = await loadIncidentInvestigateCommand();
  const { deps, calls } = baseDeps({ createModelPort: createModelPortFactoryFor(throwingModelPort()) });
  const incidentId = randomUUID();

  // "staging" exists under both "checkout" and "billing"; "billing" has no
  // "prod" environment, so this must read as a scope MISMATCH, not unknown.
  const error = await assert.rejects(
    command.runIncidentInvestigateCommand(argvFor({ service: 'billing', env: 'prod', incidentId }), deps),
  );
  assert.equal(error.reason, 'environment-of-another-service');
  assert.deepEqual(calls.createRun, []);
});

test('an unknown <incident-id> is refused unknown-incident, and calls no createRun', async () => {
  const command = await loadIncidentInvestigateCommand();
  const { deps, calls } = baseDeps({ createModelPort: createModelPortFactoryFor(throwingModelPort()) });
  const incidentId = randomUUID();
  // deps.incidents.getIncident already defaults to returning null.

  const error = await assert.rejects(
    command.runIncidentInvestigateCommand(argvFor({ incidentId }), deps),
  );
  assert.equal(error.reason, 'unknown-incident');
  assert.deepEqual(calls.getIncident, [incidentId]);
  assert.deepEqual(calls.createRun, []);
});

test('an Incident whose own primaryScope disagrees with the resolved <service>/<env> is refused incident-scope-mismatch, and calls no createRun', async () => {
  const command = await loadIncidentInvestigateCommand();
  const incidentId = randomUUID();
  const { deps, calls } = baseDeps({
    createModelPort: createModelPortFactoryFor(throwingModelPort()),
    incidents: {
      getIncident: async () =>
        // Same Service, but the OTHER Environment of it ("prod") — not "staging".
        intakeDerivedIncident({ id: incidentId, serviceId: serviceCheckoutId, environmentId: environmentProdId }),
    },
  });

  const error = await assert.rejects(
    command.runIncidentInvestigateCommand(argvFor({ incidentId }), deps),
  );
  assert.equal(error.reason, 'incident-scope-mismatch');
  assert.deepEqual(calls.createRun, []);
});

test('a matching Incident with zero SourceBindings for its Environment is refused no-source-bindings, and calls no createRun', async () => {
  const command = await loadIncidentInvestigateCommand();
  const incidentId = randomUUID();
  const { deps, calls } = baseDeps({
    createModelPort: createModelPortFactoryFor(throwingModelPort()),
    incidents: {
      getIncident: async () =>
        intakeDerivedIncident({ id: incidentId, serviceId: serviceCheckoutId, environmentId: environmentStagingId }),
    },
    // registry.snapshot defaults to zero sourceBindings.
  });

  const error = await assert.rejects(
    command.runIncidentInvestigateCommand(argvFor({ incidentId }), deps),
  );
  assert.equal(error.reason, 'no-source-bindings');
  assert.deepEqual(calls.createRun, []);
});

test('a port construction refusal is mapped to source-bindings-refused, and calls no createRun', async () => {
  const command = await loadIncidentInvestigateCommand();
  const incidentId = randomUUID();
  const binding = labBinding({ environmentId: environmentStagingId });
  const { deps, calls } = baseDeps({
    createModelPort: createModelPortFactoryFor(throwingModelPort()),
    incidents: {
      getIncident: async () =>
        intakeDerivedIncident({ id: incidentId, serviceId: serviceCheckoutId, environmentId: environmentStagingId }),
    },
    registry: { snapshot: async () => registrySnapshot({ sourceBindings: [binding] }) },
    createExecutor: async () => ({ ok: false, reason: 'missing-credential', sourceBindingId: binding.id }),
  });

  const error = await assert.rejects(
    command.runIncidentInvestigateCommand(argvFor({ incidentId }), deps),
  );
  assert.equal(error.reason, 'source-bindings-refused');
  assert.deepEqual(calls.createRun, []);
});

/* -------------------------------------------------------------------------- */
/* Bindings from another Environment of the same Service are never passed    */
/* to the port. Oracle: a spy WRAPPING the real createBoundInvestigationExecutor.*/
/* -------------------------------------------------------------------------- */

test('bindings from another Environment of the same Service are never passed to the executor factory', async () => {
  const command = await loadIncidentInvestigateCommand();
  const incidentId = randomUUID();
  const targetBinding = labBinding({ environmentId: environmentStagingId, name: 'lab-staging' });
  const otherEnvironmentBinding = labBinding({ environmentId: environmentProdId, name: 'lab-prod' });

  const capturedOptions = [];
  const createExecutor = async (options) => {
    capturedOptions.push(options);
    return createBoundInvestigationExecutor(options);
  };

  const { deps } = baseDeps({
    createModelPort: createModelPortFactoryFor(throwingModelPort()),
    incidents: {
      getIncident: async () =>
        intakeDerivedIncident({ id: incidentId, serviceId: serviceCheckoutId, environmentId: environmentStagingId }),
    },
    registry: {
      snapshot: async () => registrySnapshot({ sourceBindings: [targetBinding, otherEnvironmentBinding] }),
    },
    createExecutor,
  });

  // The fake model port throws on the first role call, well after binding
  // filtering already ran; only whether the run REJECTED matters here, not why.
  await assert.rejects(command.runIncidentInvestigateCommand(argvFor({ incidentId }), deps));

  assert.equal(capturedOptions.length, 1, 'the executor factory must be called exactly once');
  assert.deepEqual(
    capturedOptions[0].bindings.map((binding) => binding.id).sort(),
    [targetBinding.id],
    'only the target Environment\'s own binding may reach the executor factory',
  );
});

/* -------------------------------------------------------------------------- */
/* The composition passes evidenceProvenance 'required'                       */
/* -------------------------------------------------------------------------- */

test("the composition passes evidenceProvenance 'required': a fake executor's ok outcome with no provenance throws the node's own message", async () => {
  const command = await loadIncidentInvestigateCommand();
  const incidentId = randomUUID();
  const binding = labBinding({ environmentId: environmentStagingId });

  const { deps } = baseDeps({
    createModelPort: createModelPortFactoryFor(oneHypothesisThenThrowingModelPort()),
    incidents: {
      getIncident: async () =>
        intakeDerivedIncident({ id: incidentId, serviceId: serviceCheckoutId, environmentId: environmentStagingId }),
    },
    registry: { snapshot: async () => registrySnapshot({ sourceBindings: [binding] }) },
    // A "port fake" standing in for the real bound executor: an ok outcome
    // with non-empty output and no provenance at all.
    createExecutor: async () => ({
      ok: true,
      executor: { execute: async () => ({ status: 'ok', output: [{}] }) },
    }),
  });

  await assert.rejects(
    command.runIncidentInvestigateCommand(argvFor({ incidentId }), deps),
    /evidence provenance is required/,
  );
});

/* -------------------------------------------------------------------------- */
/* Run identity: default runId, --run-id override, runs.input shape, asOf     */
/* -------------------------------------------------------------------------- */

test('a fresh run creates the run with the default sha256-derived runId and the pinned runs.input shape, and asOf comes from deps.now() at creation', async () => {
  const command = await loadIncidentInvestigateCommand();
  const incidentId = randomUUID();
  const binding = labBinding({ environmentId: environmentStagingId });
  const port = throwingModelPort();

  const { deps, calls } = baseDeps({
    createModelPort: createModelPortFactoryFor(port),
    incidents: {
      getIncident: async () =>
        intakeDerivedIncident({ id: incidentId, serviceId: serviceCheckoutId, environmentId: environmentStagingId }),
    },
    registry: { snapshot: async () => registrySnapshot({ sourceBindings: [binding] }) },
  });

  await assert.rejects(command.runIncidentInvestigateCommand(argvFor({ incidentId }), deps));

  assert.equal(calls.createRun.length, 1);
  const { runId, input } = calls.createRun[0];
  assert.equal(runId, defaultRunIdFor(incidentId));
  assert.equal(input.kind, 'incident-investigation');
  assert.equal(input.v, 1);
  assert.equal(input.incidentId, incidentId);
  assert.equal(input.serviceId, serviceCheckoutId);
  assert.equal(input.environmentId, environmentStagingId);
  assert.equal(input.roles, 'model');
  assert.equal(input.asOf, FIXED_NOW);
  assert.deepEqual(Object.keys(input).sort(), ['asOf', 'budget', 'environmentId', 'incidentId', 'kind', 'roles', 'serviceId', 'v'].sort());
  for (const field of ['maxIterations', 'llmCallBudget', 'reservedChallengeBudget']) {
    assert.equal(typeof input.budget[field], 'number');
    assert.ok(Number.isInteger(input.budget[field]) && input.budget[field] >= 0, `budget.${field} must be a non-negative integer`);
  }
  assert.ok(calls.now.length >= 1, 'now() must be called at least once, to set asOf');
  assert.ok(port.calls.length >= 1, 'a fresh run must reach the graph (kind: start), calling the model port');
});

test('--run-id overrides the default runId', async () => {
  const command = await loadIncidentInvestigateCommand();
  const incidentId = randomUUID();
  const binding = labBinding({ environmentId: environmentStagingId });
  const explicitRunId = 'aic146c4b-explicit-run-id';

  const { deps, calls } = baseDeps({
    createModelPort: createModelPortFactoryFor(throwingModelPort()),
    incidents: {
      getIncident: async () =>
        intakeDerivedIncident({ id: incidentId, serviceId: serviceCheckoutId, environmentId: environmentStagingId }),
    },
    registry: { snapshot: async () => registrySnapshot({ sourceBindings: [binding] }) },
  });

  await assert.rejects(command.runIncidentInvestigateCommand(argvFor({ incidentId, runId: explicitRunId }), deps));

  assert.equal(calls.createRun.length, 1);
  assert.equal(calls.createRun[0].runId, explicitRunId);
});

test('on an existing run, asOf is read from runs.input, never re-derived from now()', async () => {
  const command = await loadIncidentInvestigateCommand();
  const incidentId = randomUUID();
  const runId = 'aic146c4b-existing-run-asof';
  const storedInput = {
    kind: 'incident-investigation',
    v: 1,
    incidentId,
    serviceId: serviceCheckoutId,
    environmentId: environmentStagingId,
    roles: 'model',
    asOf: '2020-01-01T00:00:00.000Z',
    budget: { maxIterations: 5, llmCallBudget: 5, reservedChallengeBudget: 1 },
  };
  const binding = labBinding({ environmentId: environmentStagingId });

  const { deps, calls } = baseDeps({
    createModelPort: createModelPortFactoryFor(throwingModelPort()),
    incidents: {
      getIncident: async () =>
        intakeDerivedIncident({ id: incidentId, serviceId: serviceCheckoutId, environmentId: environmentStagingId }),
    },
    registry: { snapshot: async () => registrySnapshot({ sourceBindings: [binding] }) },
    runs: {
      getRun: async () => ({
        runId,
        status: 'queued',
        input: storedInput,
        ownerWorkerId: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        executionAttempt: 0,
        recoveryCount: 0,
        terminalReason: null,
      }),
    },
  });

  await assert.rejects(command.runIncidentInvestigateCommand(argvFor({ incidentId, runId }), deps));

  assert.deepEqual(calls.createRun, [], 'an existing run must never be re-created');
  assert.deepEqual(calls.now, [], 'now() must never be called for an existing run: neither asOf nor the executor clock needs it here');
});

/* -------------------------------------------------------------------------- */
/* Refusals from an existing run: run-input-mismatch, run-failed,             */
/* run-waiting-human, run-held                                                */
/* -------------------------------------------------------------------------- */

function matchingStoredInput({ incidentId, overrides = {} } = {}) {
  return {
    kind: 'incident-investigation',
    v: 1,
    incidentId,
    serviceId: serviceCheckoutId,
    environmentId: environmentStagingId,
    roles: 'model',
    asOf: '2020-01-01T00:00:00.000Z',
    budget: { maxIterations: 5, llmCallBudget: 5, reservedChallengeBudget: 1 },
    ...overrides,
  };
}

function depsForExistingRun({ incidentId, runId, status, inputOverrides, runsOverrides } = {}) {
  const binding = labBinding({ environmentId: environmentStagingId });
  return baseDeps({
    createModelPort: createModelPortFactoryFor(throwingModelPort()),
    incidents: {
      getIncident: async () =>
        intakeDerivedIncident({ id: incidentId, serviceId: serviceCheckoutId, environmentId: environmentStagingId }),
    },
    registry: { snapshot: async () => registrySnapshot({ sourceBindings: [binding] }) },
    runs: {
      getRun: async () => ({
        runId,
        status,
        input: matchingStoredInput({ incidentId, overrides: inputOverrides }),
        ownerWorkerId: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        executionAttempt: 0,
        recoveryCount: 0,
        terminalReason: null,
      }),
      ...runsOverrides,
    },
  });
}

test('an existing run whose stored input disagrees on environmentId is refused run-input-mismatch', async () => {
  const command = await loadIncidentInvestigateCommand();
  const incidentId = randomUUID();
  const runId = 'aic146c4b-mismatch-run';
  const { deps, calls } = depsForExistingRun({
    incidentId,
    runId,
    status: 'queued',
    inputOverrides: { environmentId: environmentProdId },
  });

  const error = await assert.rejects(
    command.runIncidentInvestigateCommand(argvFor({ incidentId, runId }), deps),
  );
  assert.equal(error.reason, 'run-input-mismatch');
  assert.deepEqual(calls.createRun, []);
});

test('an existing failed run is refused run-failed', async () => {
  const command = await loadIncidentInvestigateCommand();
  const incidentId = randomUUID();
  const runId = 'aic146c4b-failed-run';
  const { deps, calls } = depsForExistingRun({ incidentId, runId, status: 'failed' });

  const error = await assert.rejects(
    command.runIncidentInvestigateCommand(argvFor({ incidentId, runId }), deps),
  );
  assert.equal(error.reason, 'run-failed');
  assert.deepEqual(calls.createRun, []);
});

test('an existing waiting_human run is refused run-waiting-human', async () => {
  const command = await loadIncidentInvestigateCommand();
  const incidentId = randomUUID();
  const runId = 'aic146c4b-waiting-human-run';
  const { deps, calls } = depsForExistingRun({ incidentId, runId, status: 'waiting_human' });

  const error = await assert.rejects(
    command.runIncidentInvestigateCommand(argvFor({ incidentId, runId }), deps),
  );
  assert.equal(error.reason, 'run-waiting-human');
  assert.deepEqual(calls.createRun, []);
});

test('an existing running run whose lease sweepExpired reports as still live is refused run-held, and claimRun is never called', async () => {
  const command = await loadIncidentInvestigateCommand();
  const incidentId = randomUUID();
  const runId = 'aic146c4b-held-run';
  const { deps, calls } = depsForExistingRun({
    incidentId,
    runId,
    status: 'running',
    // sweepExpired reports NOTHING requeued: this run's lease is still live.
    runsOverrides: { sweepExpired: async () => [] },
  });

  const error = await assert.rejects(
    command.runIncidentInvestigateCommand(argvFor({ incidentId, runId }), deps),
  );
  assert.equal(error.reason, 'run-held');
  assert.deepEqual(calls.claimRun, []);
  assert.deepEqual(calls.openWriteContext, []);
});

test('an existing running run whose lease sweepExpired reports as expired proceeds to claim it, rather than refusing run-held', async () => {
  const command = await loadIncidentInvestigateCommand();
  const incidentId = randomUUID();
  const runId = 'aic146c4b-expired-run';
  const { deps, calls } = depsForExistingRun({
    incidentId,
    runId,
    status: 'running',
    // sweepExpired reports THIS run requeued: the crashed worker's lease died.
    runsOverrides: { sweepExpired: async () => [runId] },
  });

  await assert.rejects(command.runIncidentInvestigateCommand(argvFor({ incidentId, runId }), deps));

  assert.equal(calls.claimRun.length, 1, 'an expired lease must be reclaimed rather than refused run-held');
});

/* -------------------------------------------------------------------------- */
/* checkpointer-not-provisioned — the one refusal that CAN follow a createRun */
/* -------------------------------------------------------------------------- */

test('a checkpointer construction failure is refused checkpointer-not-provisioned, after createRun/claimRun/openWriteContext already ran', async () => {
  const command = await loadIncidentInvestigateCommand();
  const incidentId = randomUUID();
  const binding = labBinding({ environmentId: environmentStagingId });

  const { deps, calls } = baseDeps({
    createModelPort: createModelPortFactoryFor(throwingModelPort()),
    incidents: {
      getIncident: async () =>
        intakeDerivedIncident({ id: incidentId, serviceId: serviceCheckoutId, environmentId: environmentStagingId }),
    },
    registry: { snapshot: async () => registrySnapshot({ sourceBindings: [binding] }) },
    createCheckpointer: async () => {
      throw new Error('relation "langgraph.checkpoint_migrations" does not exist');
    },
  });

  const error = await assert.rejects(
    command.runIncidentInvestigateCommand(argvFor({ incidentId }), deps),
  );
  assert.equal(error.reason, 'checkpointer-not-provisioned');
  assert.equal(calls.createRun.length, 1, 'a fresh run must already have been created before the checkpointer is built');
  assert.equal(calls.claimRun.length, 1);
  assert.equal(calls.openWriteContext.length, 1);
});

/* -------------------------------------------------------------------------- */
/* fresh -> start; existing checkpoint -> continue; completed -> summary only */
/* -------------------------------------------------------------------------- */

/** Reasoning whose generate_hypotheses reports zero hypotheses: the graph terminates immediately (T1: stalled), never calling `execute`. */
function noHypothesesReasoning() {
  return {
    async generate_hypotheses() {
      return { hypotheses: [] };
    },
    async interpret_residual_evidence() {
      return {};
    },
    async challenge_hypothesis() {
      return {
        alternative: { id: 'unused-alternative', statement: 'unused', createdBy: 'challenge' },
        discriminatingTests: [],
      };
    },
    async propose_conclusion() {
      return { conclusion: { kind: 'inconclusive', causes: [] } };
    },
  };
}

async function neverCalledExecute() {
  throw new Error('EXECUTE_MUST_NOT_BE_CALLED: zero hypotheses plans zero tests');
}

const SEED_BUDGET = Object.freeze({ maxIterations: 5, llmCallBudget: 5, reservedChallengeBudget: 1 });

/** Runs a real, minimal investigation graph to completion (T1: stalled) against `checkpointer`, seeding a finished, checkpointed thread for `runId` — entirely independent of the command under test. */
async function seedFinishedCheckpoint({ checkpointer, runId, incident }) {
  const { buildInitialState } = await loadInvestigateCommand();
  const nodes = createInvestigationNodes({
    reasoning: noHypothesesReasoning(),
    execute: neverCalledExecute,
    asOf: () => FIXED_NOW,
    evidenceProvenance: 'optional',
  });
  const seedGraph = createInvestigationGraph({ nodes, checkpointer });
  return seedGraph.execute(
    { kind: 'start', state: buildInitialState(runId, { incident, budget: SEED_BUDGET }) },
    { threadId: runId },
  );
}

test('a completed run prints the checkpointed summary without invoking the graph: no claim, no write context, no fetch, no model-port call', async () => {
  const command = await loadIncidentInvestigateCommand();
  const incidentId = randomUUID();
  const runId = 'aic146c4b-completed-run';
  const incident = intakeDerivedIncident({ id: incidentId, serviceId: serviceCheckoutId, environmentId: environmentStagingId });
  const binding = labBinding({ environmentId: environmentStagingId });

  const sharedCheckpointer = new MemorySaver();
  const finalState = await seedFinishedCheckpoint({ checkpointer: sharedCheckpointer, runId, incident });

  const port = throwingModelPort();
  const fetchCalls = [];

  const { deps, calls, stdoutLines } = baseDeps({
    createModelPort: createModelPortFactoryFor(port),
    fetch: async (...args) => {
      fetchCalls.push(args);
      throw new Error('FETCH_MUST_NOT_BE_CALLED_FOR_A_COMPLETED_RUN');
    },
    incidents: { getIncident: async () => incident },
    registry: { snapshot: async () => registrySnapshot({ sourceBindings: [binding] }) },
    runs: {
      getRun: async () => ({
        runId,
        status: 'completed',
        input: matchingStoredInput({ incidentId }),
        ownerWorkerId: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        executionAttempt: 1,
        recoveryCount: 0,
        terminalReason: null,
      }),
    },
    createCheckpointer: async () => sharedCheckpointer,
  });

  await command.runIncidentInvestigateCommand(argvFor({ incidentId, runId }), deps);

  assert.deepEqual(calls.claimRun, [], 'a completed run must never be claimed');
  assert.deepEqual(calls.openWriteContext, [], 'a completed run must never open a write context');
  assert.equal(port.calls.length, 0, 'a completed run must never call a reasoning role');
  assert.equal(fetchCalls.length, 0, 'a completed run must never call fetch');

  const summaryModule = await loadInvestigationSummary();
  assert.equal(stdoutLines.length, 1);
  const printed = JSON.parse(stdoutLines[0]);
  assert.deepEqual(printed, summaryModule.summarizeInvestigation(runId, finalState));
});

test('stdout is exactly one JSON line whose keys equal summarizeInvestigation\'s six keys, checked against a literal key list too', async () => {
  const command = await loadIncidentInvestigateCommand();
  const incidentId = randomUUID();
  const runId = 'aic146c4b-summary-keys-run';
  const incident = intakeDerivedIncident({ id: incidentId, serviceId: serviceCheckoutId, environmentId: environmentStagingId });
  const binding = labBinding({ environmentId: environmentStagingId });

  const sharedCheckpointer = new MemorySaver();
  const finalState = await seedFinishedCheckpoint({ checkpointer: sharedCheckpointer, runId, incident });

  const { deps, stdoutLines } = baseDeps({
    createModelPort: createModelPortFactoryFor(throwingModelPort()),
    incidents: { getIncident: async () => incident },
    registry: { snapshot: async () => registrySnapshot({ sourceBindings: [binding] }) },
    runs: {
      getRun: async () => ({
        runId,
        status: 'completed',
        input: matchingStoredInput({ incidentId }),
        ownerWorkerId: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        executionAttempt: 1,
        recoveryCount: 0,
        terminalReason: null,
      }),
    },
    createCheckpointer: async () => sharedCheckpointer,
  });

  await command.runIncidentInvestigateCommand(argvFor({ incidentId, runId }), deps);

  assert.equal(stdoutLines.length, 1);
  const printed = JSON.parse(stdoutLines[0]);
  const summaryModule = await loadInvestigationSummary();
  assert.deepEqual(
    Object.keys(printed).sort(),
    Object.keys(summaryModule.summarizeInvestigation(runId, finalState)).sort(),
  );
  // Independent, literal oracle — never derived from summarizeInvestigation's own output.
  assert.deepEqual(Object.keys(printed).sort(), ['conclusion', 'evidence', 'hypotheses', 'runId', 'stopKind', 'trials'].sort());
});

test('an existing run whose checkpoint is already finished (a crash after completion, before context.complete()) is resumed with continue, reaching the same final state without calling the model port again', async () => {
  const command = await loadIncidentInvestigateCommand();
  const incidentId = randomUUID();
  const runId = 'aic146c4b-continue-run';
  const incident = intakeDerivedIncident({ id: incidentId, serviceId: serviceCheckoutId, environmentId: environmentStagingId });
  const binding = labBinding({ environmentId: environmentStagingId });

  const sharedCheckpointer = new MemorySaver();
  const finalState = await seedFinishedCheckpoint({ checkpointer: sharedCheckpointer, runId, incident });

  // The RUN ROW is still "running": the process that finished the graph
  // crashed before it ever called context.complete().
  const port = throwingModelPort();
  const { deps, calls, stdoutLines } = baseDeps({
    createModelPort: createModelPortFactoryFor(port),
    incidents: { getIncident: async () => incident },
    registry: { snapshot: async () => registrySnapshot({ sourceBindings: [binding] }) },
    runs: {
      getRun: async () => ({
        runId,
        status: 'running',
        input: matchingStoredInput({ incidentId }),
        ownerWorkerId: 'dead-worker',
        leaseExpiresAt: null,
        heartbeatAt: null,
        executionAttempt: 1,
        recoveryCount: 0,
        terminalReason: null,
      }),
      sweepExpired: async () => [runId],
    },
    createCheckpointer: async () => sharedCheckpointer,
  });

  await command.runIncidentInvestigateCommand(argvFor({ incidentId, runId }), deps);

  assert.equal(calls.claimRun.length, 1, 'an expired lease must be reclaimed');
  assert.equal(
    port.calls.length,
    0,
    'continue on an already-finished thread is a no-op: it must invoke no node, so the model port fake (which throws unconditionally) is never called',
  );

  const summaryModule = await loadInvestigationSummary();
  assert.equal(stdoutLines.length, 1);
  const printed = JSON.parse(stdoutLines[0]);
  assert.deepEqual(printed, summaryModule.summarizeInvestigation(runId, finalState));
});

/* -------------------------------------------------------------------------- */
/* --roles model: every role call goes through execution.committed under a   */
/* model.role key                                                             */
/* -------------------------------------------------------------------------- */

test('--roles model with an injected createModelPort: the role call reaches execution.committed under a model.role exec key', async () => {
  const command = await loadIncidentInvestigateCommand();
  const incidentId = randomUUID();
  const binding = labBinding({ environmentId: environmentStagingId });
  const port = throwingModelPort();

  const { deps, writeContexts } = baseDeps({
    createModelPort: createModelPortFactoryFor(port),
    incidents: {
      getIncident: async () =>
        intakeDerivedIncident({ id: incidentId, serviceId: serviceCheckoutId, environmentId: environmentStagingId }),
    },
    registry: { snapshot: async () => registrySnapshot({ sourceBindings: [binding] }) },
  });

  await assert.rejects(command.runIncidentInvestigateCommand(argvFor({ incidentId, roles: 'model' }), deps));

  assert.equal(writeContexts.length, 1, 'exactly one write context must have been opened for this run');
  const [writeContext] = writeContexts;
  assert.ok(writeContext.calls.length >= 1, 'at least one role call must have reached execution.committed');
  for (const execKey of writeContext.calls) {
    assert.match(execKey, /^model\.role\/sha256:[0-9a-f]{64}$/, `every commit key must carry the model.role prefix, got: ${execKey}`);
  }
  assert.ok(port.calls.length >= 1, 'the port itself must also have been called at least once');
});
