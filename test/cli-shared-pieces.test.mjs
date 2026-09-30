/**
 * AIC-146 sub-slice c4a: the shared pieces the upcoming `aic incident
 * investigate` command (c4b) reuses, extracted from `apps/cli/src/commands`
 * so neither command carries its own copy
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation"):
 *
 *   - `summarizeInvestigation(runId, finalState)` — a new module,
 *     `apps/cli/src/commands/investigation-summary.ts`, extracted from the
 *     six-key object `apps/cli/src/commands/investigate.ts` builds at the
 *     end of `runInvestigate` (test/cli-investigate.test.mjs pins the exact
 *     key set `{conclusion, evidence, hypotheses, runId, stopKind, trials}`).
 *   - `resolveIncidentScope(registry, serviceName, environmentName)` — a
 *     result-returning export of `apps/cli/src/commands/incident.ts`'s
 *     existing `resolveScope`, which never throws and whose refusal names no
 *     value.
 *   - `createModelReasoning(port, execution?)` — the existing CLI factory
 *     (`apps/cli/src/commands/investigate.ts`) forwarding an optional
 *     `execution: CommittedExecution` (`@aic/domain`) to each of the four
 *     model roles (`@aic/roles`'s `ModelRoleOptions.execution`).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as domain from '@aic/domain';
import * as evals from '@aic/evals';
import { createInvestigationGraph } from '@aic/graph';

import { childEnv } from './fixtures/child-env.mjs';
import { createFakeCommittedExecution } from './fixtures/fake-committed-execution.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = resolve(projectRoot, 'apps/cli/dist/index.js');

const scratchRoot = mkdtempSync(join(tmpdir(), 'aic-cli-shared-pieces-'));
test.after(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* 1. summarizeInvestigation(runId, finalState)                               */
/* -------------------------------------------------------------------------- */

function loadInvestigationSummary() {
  return import('../apps/cli/dist/commands/investigation-summary.js');
}

/** The same empty `IncidentState` shape `buildInitialState` (investigate.ts) produces, plus a stop and a conclusion. */
function finalStateWithNoHypotheses() {
  return {
    incident: { id: 'aic146c4a-fixture-incident' },
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [{ id: 't-1' }, { id: 't-2' }],
    evidence: [{ id: 'e-1' }],
    assessments: [],
    control: {
      runId: 'aic146c4a-run-1',
      schemaVersion: domain.INCIDENT_STATE_SCHEMA_VERSION,
      statusRulesVersion: domain.STATUS_RULES_VERSION,
      phase: 'concluded',
      stopKind: 'sufficient',
      maxIterations: 5,
      llmCallBudget: 5,
      reservedChallengeBudget: 1,
      challengeRounds: 0,
      iterationsUsed: 1,
      llmCallsUsed: 0,
      resumeCount: 0,
      humanReview: false,
    },
    conclusion: { hypothesisId: null, statement: 'no cause identified', producedBy: 'scripted' },
  };
}

test('summarizeInvestigation(runId, finalState) returns exactly the six keys runId, stopKind, trials, evidence, hypotheses, conclusion, in that order, for a final state with no hypotheses', async () => {
  const summaryModule = await loadInvestigationSummary();
  assert.equal(
    typeof summaryModule.summarizeInvestigation,
    'function',
    'apps/cli/src/commands/investigation-summary.ts must export summarizeInvestigation(runId, finalState)',
  );

  const finalState = finalStateWithNoHypotheses();
  const summary = summaryModule.summarizeInvestigation('aic146c4a-run-1', finalState);

  assert.deepEqual(
    Object.keys(summary),
    ['runId', 'stopKind', 'trials', 'evidence', 'hypotheses', 'conclusion'],
    'summarizeInvestigation must return exactly these six keys, in this order',
  );
  assert.deepEqual(summary, {
    runId: 'aic146c4a-run-1',
    stopKind: 'sufficient',
    trials: 2,
    evidence: ['e-1'],
    hypotheses: [],
    conclusion: { hypothesisId: null, statement: 'no cause identified', producedBy: 'scripted' },
  });
});

test('summarizeInvestigation derives each hypothesis\'s status the same way the state-derivation rules do: with no predictions or assessments, an untested hypothesis is "candidate"', async () => {
  const summaryModule = await loadInvestigationSummary();

  const finalState = {
    ...finalStateWithNoHypotheses(),
    hypotheses: [{ id: 'h-1', statement: 'a candidate cause', createdBy: 'initial' }],
    control: { ...finalStateWithNoHypotheses().control, stopKind: null },
    conclusion: null,
  };

  const summary = summaryModule.summarizeInvestigation('aic146c4a-run-1', finalState);

  // Hand-derived, not called through domain.deriveHypothesisStatus: with
  // empty predictions, assessments and evidence, evaluation.ts's own rule
  // table (packages/domain/src/evaluation.ts) falls through every
  // rejected/weakened/supported/corroborated branch untaken and returns
  // 'candidate' as its final default.
  assert.deepEqual(summary.hypotheses, [{ id: 'h-1', status: 'candidate' }]);
  assert.equal(summary.stopKind, null);
  assert.equal(summary.conclusion, null);
});

test('investigate.ts stdout for a scripted-roles fixture run equals JSON.stringify(summarizeInvestigation(runId, finalState)) over a scripted composition run independently', async () => {
  const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === 'deployment-caused-incident-a');
  assert.ok(scenario, 'fixture sanity: REPLAY_SCENARIOS must carry deployment-caused-incident-a');

  const dir = mkdtempSync(join(scratchRoot, 'case-'));
  try {
    const runId = 'aic146c4a-summary-parity-run';
    const budget = {
      maxIterations: evals.BENCHMARK_BUDGET_POLICY.maxIterations,
      llmCallBudget: evals.BENCHMARK_BUDGET_POLICY.llmCallBudget,
      reservedChallengeBudget: evals.BENCHMARK_BUDGET_POLICY.reservedChallengeBudget,
    };
    const content = {
      asOf: evals.REPLAY_AS_OF,
      incident: { id: 'aic146c4a-summary-parity-incident', primaryScope: evals.BENCHMARK_PRIMARY_SCOPE },
      budget,
      fixture: scenario.fixture,
    };
    const replayPath = join(dir, 'replay.json');
    writeFileSync(replayPath, JSON.stringify(content), 'utf8');

    const stdout = execFileSync(
      process.execPath,
      [cliPath, 'investigate', '--replay', replayPath, '--roles', 'scripted', '--run-id', runId],
      { cwd: projectRoot, encoding: 'utf8', env: childEnv() },
    );

    const { scriptedNodes } = await import('../scripts/lane-arms.mjs');
    const nodes = scriptedNodes({ runId, fixture: scenario.fixture });
    const graph = createInvestigationGraph({ nodes });
    const finalState = await graph.execute({
      kind: 'start',
      state: {
        incident: content.incident,
        hypotheses: [],
        predictions: [],
        tests: [],
        trials: [],
        evidence: [],
        assessments: [],
        control: {
          runId,
          schemaVersion: domain.INCIDENT_STATE_SCHEMA_VERSION,
          statusRulesVersion: domain.STATUS_RULES_VERSION,
          phase: 'normalizing',
          maxIterations: budget.maxIterations,
          llmCallBudget: budget.llmCallBudget,
          reservedChallengeBudget: budget.reservedChallengeBudget,
          challengeRounds: 0,
          iterationsUsed: 0,
          llmCallsUsed: 0,
          resumeCount: 0,
          humanReview: false,
        },
      },
    });

    const summaryModule = await loadInvestigationSummary();
    const expected = `${JSON.stringify(summaryModule.summarizeInvestigation(runId, finalState))}\n`;

    assert.equal(stdout, expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* 2. resolveIncidentScope(registry, serviceName, environmentName)            */
/* -------------------------------------------------------------------------- */

function loadIncidentCommand() {
  return import('../apps/cli/dist/commands/incident.js');
}

const serviceCheckoutId = randomUUID();
const environmentCheckoutStagingId = randomUUID();
const serviceBillingId = randomUUID();
const environmentBillingStagingId = randomUUID();
const serviceReportingId = randomUUID();

/**
 * The same three-Service, two-Environment shape
 * test/cli-incident-command.test.mjs's own `registrySnapshotFixture` uses,
 * hand-built again here rather than imported: "reporting" has no
 * Environment at all, and "staging" exists under both "checkout" and
 * "billing" — so `checkPrimaryScope` (@aic/domain) can tell
 * "environment-of-another-service" apart from a plain "unknown-environment".
 */
function registrySnapshotFixture() {
  return {
    services: [
      { id: serviceCheckoutId, name: 'checkout', repositoryAliases: [] },
      { id: serviceBillingId, name: 'billing', repositoryAliases: [] },
      { id: serviceReportingId, name: 'reporting', repositoryAliases: [] },
    ],
    environments: [
      { id: environmentCheckoutStagingId, serviceId: serviceCheckoutId, name: 'staging' },
      { id: environmentBillingStagingId, serviceId: serviceBillingId, name: 'staging' },
    ],
    sourceBindings: [],
    credentialRefs: [],
    actionPolicies: [],
  };
}

test('resolveIncidentScope resolves a <service>/<env> pair that both exist and are scoped together, without throwing', async () => {
  const incident = await loadIncidentCommand();
  assert.equal(
    typeof incident.resolveIncidentScope,
    'function',
    'apps/cli/src/commands/incident.ts must export resolveIncidentScope(registry, serviceName, environmentName)',
  );

  const result = incident.resolveIncidentScope(registrySnapshotFixture(), 'checkout', 'staging');

  assert.deepEqual(result, {
    ok: true,
    serviceId: serviceCheckoutId,
    environmentId: environmentCheckoutStagingId,
  });
});

test('resolveIncidentScope returns { ok: false, reason: "unknown-service" } for a <service> that names no Service, and never throws', async () => {
  const incident = await loadIncidentCommand();

  const result = incident.resolveIncidentScope(registrySnapshotFixture(), 'ghost', 'staging');

  assert.deepEqual(result, { ok: false, reason: 'unknown-service' });
});

test('resolveIncidentScope returns { ok: false, reason: "unknown-environment" } for an <env> that names no Environment anywhere, and never throws', async () => {
  const incident = await loadIncidentCommand();

  const result = incident.resolveIncidentScope(registrySnapshotFixture(), 'checkout', 'nowhere');

  assert.deepEqual(result, { ok: false, reason: 'unknown-environment' });
});

test('resolveIncidentScope returns { ok: false, reason: "environment-of-another-service" } for an <env> that exists only under a DIFFERENT Service, and never throws', async () => {
  const incident = await loadIncidentCommand();

  // "staging" exists under "checkout" and "billing", but "reporting" has no
  // Environment of its own — this must resolve as belonging to a different
  // service, never as merely unknown.
  const result = incident.resolveIncidentScope(registrySnapshotFixture(), 'reporting', 'staging');

  assert.deepEqual(result, { ok: false, reason: 'environment-of-another-service' });
});

test('the refusal result of resolveIncidentScope carries no name: exactly the own keys {ok, reason}, nothing else', async () => {
  const incident = await loadIncidentCommand();

  const result = incident.resolveIncidentScope(registrySnapshotFixture(), 'ghost', 'nowhere');

  assert.deepEqual(Object.keys(result).sort(), ['ok', 'reason'].sort());
});

/* -------------------------------------------------------------------------- */
/* 3. createModelReasoning(port, execution?) forwards execution to each role  */
/* -------------------------------------------------------------------------- */

function loadInvestigateModule() {
  return import('../apps/cli/dist/commands/investigate.js');
}

function fakeStateFor(runId) {
  return {
    incident: { id: 'aic146c4a-fake-incident' },
    hypotheses: [{ id: 'h-1', statement: 'a candidate cause', createdBy: 'initial' }],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: { runId, stopKind: 'sufficient', challengeRounds: 0, iterationsUsed: 0, resumeCount: 0 },
  };
}

test('createModelReasoning(port, execution) forwards execution to all four model roles: each of the four reasoning calls commits under a key starting with the model.role prefix', async () => {
  const investigateModule = await loadInvestigateModule();
  const fakeExecution = createFakeCommittedExecution();

  // The port throws on every call (this row reads what execution committed
  // for, not a parsed model answer) — the same fake-port shape the existing
  // createModelReasoning(fakePort) rows in test/cli-investigate.test.mjs use.
  const fakePort = {
    async complete() {
      throw new Error('fake port refuses: this row reads the execution key committed, not an answer');
    },
  };

  const reasoning = investigateModule.createModelReasoning(fakePort, fakeExecution);
  const state = fakeStateFor('aic146c4a-execution-forwarding-run');

  await reasoning.generate_hypotheses(state).catch(() => {});
  await reasoning.interpret_residual_evidence(state).catch(() => {});
  await reasoning.challenge_hypothesis(state, 'h-1').catch(() => {});
  await reasoning.propose_conclusion(state).catch(() => {});

  assert.equal(
    fakeExecution.calls.length,
    4,
    'each of the four reasoning calls must reach execution.committed exactly once',
  );
  for (const execKey of fakeExecution.calls) {
    assert.match(
      execKey,
      /^model\.role\/sha256:[0-9a-f]{64}$/,
      `every commit execution saw must carry a model.role exec key, got: ${execKey}`,
    );
  }
});

test('createModelReasoning(port) with no execution calls the port on every role call, while the same two calls with an execution reach the port once', async () => {
  const investigateModule = await loadInvestigateModule();

  // The port answers (its answer is committed as-is by execution.committed and
  // only parsed afterwards), so a committed wrapper replays the second call
  // instead of reaching the port again. The role's own parse of this answer
  // throws; this row reads the port's call count, not a parsed answer.
  function countingPort() {
    const port = {
      calls: 0,
      async complete() {
        port.calls += 1;
        return { text: '{}' };
      },
    };
    return port;
  }
  const state = fakeStateFor('aic146c4a-no-execution-run');

  const barePort = countingPort();
  const bare = investigateModule.createModelReasoning(barePort);
  await bare.generate_hypotheses(state).catch(() => {});
  await bare.generate_hypotheses(state).catch(() => {});

  const committedPort = countingPort();
  const committed = investigateModule.createModelReasoning(committedPort, createFakeCommittedExecution());
  await committed.generate_hypotheses(state).catch(() => {});
  await committed.generate_hypotheses(state).catch(() => {});

  assert.equal(barePort.calls, 2, 'without execution, every role call must reach the port');
  assert.equal(committedPort.calls, 1, 'with execution, the second call on the same state must replay the committed answer');
});
