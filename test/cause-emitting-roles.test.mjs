/**
 * AIC-123 slice 2: `generate_hypotheses` and `challenge_hypothesis` emit a
 * structured `cause` (the same `CauseDescription` shape `propose_conclusion`
 * already reads and writes), classified against the caller-supplied root-cause
 * mechanism vocabulary — the same vocabulary `propose_conclusion` and the
 * naive role already classify against.
 *
 * Every assertion here runs against a FAKE `ModelPort`, the same discipline
 * `roles-model-nodes.test.mjs` and `conclusion-role.test.mjs` already use: the
 * whole contract is decidable with no network and no credential. Nothing here
 * is a claim about model QUALITY.
 *
 * This file also pins the shared, role-agnostic pieces slice 2 introduces:
 * `causeMechanismViolation` (`@aic/domain`) — the one implementation every
 * mechanism-vocabulary role delegates its off-vocabulary refusal to — and
 * `describeMechanismVocabulary` (`@aic/roles`) — the one sentence every
 * mechanism-vocabulary role's system prompt carries — plus the
 * `CauseDescriptionSchema` length caps both `Hypothesis.cause` and
 * `CauseClaim.cause` share.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CauseClaimSchema,
  HypothesisSchema,
  INCIDENT_STATE_SCHEMA_VERSION,
  STATUS_RULES_VERSION,
} from '@aic/domain';
import * as domain from '@aic/domain';
import * as roles from '@aic/roles';

import { scopedIncident } from './fixtures/scoped-incident.mjs';

function requireDomainExport(name) {
  assert.ok(domain[name] !== undefined, `@aic/domain must export ${name}`);
  return domain[name];
}

function requireRolesExport(name) {
  assert.ok(roles[name] !== undefined, `@aic/roles must export ${name}`);
  return roles[name];
}

/** The closed root-cause mechanism vocabulary this suite exercises with. */
const MECHANISMS = Object.freeze(['config-drift', 'capacity-exhaustion']);

/**
 * A port that answers with a scripted body and records what it was asked, in
 * the same shape every other model-role suite's own `fakePort` uses.
 * `answers` is consumed in order, so a test expecting one call fails loudly on
 * a second rather than replaying the last answer forever.
 */
function fakePort(answers) {
  const requests = [];
  const remaining = [...answers];
  return {
    requests,
    port: {
      async complete(request) {
        requests.push(request);
        const next = remaining.shift();
        assert.ok(next !== undefined, 'the fake port ran out of scripted answers: an extra call means a retry');
        return {
          text: typeof next === 'string' ? next : JSON.stringify(next),
          modelId: 'claude-under-test',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    },
  };
}

/** A port that captures the request and always throws: for reading the request the role SENDS, never an answer. */
function capturingPort() {
  const requests = [];
  return {
    requests,
    port: {
      async complete(request) {
        requests.push(request);
        throw new Error('stop here: this row reads the request, not the answer');
      },
    },
  };
}

const at = () => '2026-01-01T01:00:00.000Z';

function initialState() {
  return {
    incident: scopedIncident('incident-cause-emitting-roles'),
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [
      {
        id: 'evidence-1',
        trialId: 'trial-1',
        kind: 'deploy',
        source: 'deploy-log',
        observedAt: '2026-01-01T00:00:00.000Z',
        statement: 'checkout-v42 rolled out at 00:00',
        rawRef: 'deploy/42',
      },
    ],
    assessments: [],
    control: {
      runId: 'run-cause-emitting-roles',
      schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
      statusRulesVersion: STATUS_RULES_VERSION,
      phase: 'normalizing',
      maxIterations: 4,
      llmCallBudget: 8,
      reservedChallengeBudget: 2,
      challengeRounds: 0,
      iterationsUsed: 0,
      llmCallsUsed: 0,
      resumeCount: 0,
      humanReview: false,
    },
  };
}

function stateWithLeader() {
  const state = initialState();
  state.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
  ];
  return state;
}

/* ============================================================================
 * createModelGenerateHypotheses: a structured cause on every hypothesis
 * ==========================================================================*/

test('createModelGenerateHypotheses: the provider schema declares a closed cause object on every hypothesis item, required, with the mechanism enum equal to the supplied vocabulary exactly', async () => {
  const createModelGenerateHypotheses = requireRolesExport('createModelGenerateHypotheses');
  const { port, requests } = capturingPort();
  const node = createModelGenerateHypotheses({ port, at, mechanisms: MECHANISMS });

  await node(initialState()).catch(() => {});

  assert.equal(requests.length, 1);
  const item = requests[0].outputSchema.properties.hypotheses.items;
  assert.ok(
    item.required.includes('cause'),
    `the hypothesis item schema must require cause: ${JSON.stringify(item.required)}`,
  );
  assert.deepEqual(
    item.properties.cause,
    {
      type: 'object',
      properties: {
        component: { type: 'string' },
        mechanism: { type: 'string', enum: ['config-drift', 'capacity-exhaustion'] },
        trigger: { type: 'string' },
      },
      required: ['component', 'mechanism'],
      additionalProperties: false,
    },
    'the cause object schema must match the closed shape exactly, with the mechanism enum equal to the supplied vocabulary',
  );
});

test('createModelGenerateHypotheses: a valid answer with a cause carrying a trigger returns a hypothesis carrying that exact cause', async () => {
  const createModelGenerateHypotheses = requireRolesExport('createModelGenerateHypotheses');
  const { port } = fakePort([
    {
      hypotheses: [
        {
          id: 'h-1',
          statement: 'the checkout deploy did it',
          cause: {
            component: 'checkout-service',
            mechanism: 'config-drift',
            trigger: 'the 00:00 rollout',
          },
        },
      ],
    },
  ]);
  const node = createModelGenerateHypotheses({ port, at, mechanisms: MECHANISMS });

  const update = await node(initialState());

  assert.deepEqual(update.hypotheses, [
    {
      id: 'h-1',
      statement: 'the checkout deploy did it',
      createdBy: 'initial',
      cause: {
        component: 'checkout-service',
        mechanism: 'config-drift',
        trigger: 'the 00:00 rollout',
      },
    },
  ]);
  HypothesisSchema.parse(update.hypotheses[0]);
});

test('createModelGenerateHypotheses: a cause with no trigger carries no own trigger key on the hypothesis, not trigger: undefined', async () => {
  const createModelGenerateHypotheses = requireRolesExport('createModelGenerateHypotheses');
  const { port } = fakePort([
    {
      hypotheses: [
        {
          id: 'h-1',
          statement: 'the checkout deploy did it',
          cause: { component: 'checkout-service', mechanism: 'config-drift' },
        },
      ],
    },
  ]);
  const node = createModelGenerateHypotheses({ port, at, mechanisms: MECHANISMS });

  const update = await node(initialState());

  assert.equal(
    Object.hasOwn(update.hypotheses[0].cause, 'trigger'),
    false,
    'a cause with no trigger must not carry an own trigger key at all',
  );
});

test('createModelGenerateHypotheses: refuses a hypothesis carrying no cause', async () => {
  const createModelGenerateHypotheses = requireRolesExport('createModelGenerateHypotheses');
  const ModelRoleOutputError = requireRolesExport('ModelRoleOutputError');
  const { port } = fakePort([
    { hypotheses: [{ id: 'h-1', statement: 'the checkout deploy did it' }] },
  ]);
  const node = createModelGenerateHypotheses({ port, at, mechanisms: MECHANISMS });

  await assert.rejects(() => node(initialState()), ModelRoleOutputError);
});

test('createModelGenerateHypotheses: refuses a cause whose mechanism is outside the supplied vocabulary, naming it escaped and truncated to 80 characters', async () => {
  const createModelGenerateHypotheses = requireRolesExport('createModelGenerateHypotheses');
  const ModelRoleOutputError = requireRolesExport('ModelRoleOutputError');
  const hostileMechanism = `"quoted"\nline-two-${'x'.repeat(500)}`;
  assert.ok(hostileMechanism.length > 200, 'the fixture mechanism must exceed 200 characters');
  const { port } = fakePort([
    {
      hypotheses: [
        {
          id: 'h-1',
          statement: 'the checkout deploy did it',
          cause: { component: 'checkout-service', mechanism: hostileMechanism },
        },
      ],
    },
  ]);
  const node = createModelGenerateHypotheses({ port, at, mechanisms: MECHANISMS });

  await assert.rejects(
    () => node(initialState()),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError, `expected a ModelRoleOutputError, got ${error}`);
      assert.ok(
        !error.message.includes('\n'),
        `a raw newline from a hostile mechanism must never reach the message: ${JSON.stringify(error.message)}`,
      );
      assert.doesNotMatch(
        error.message,
        /x{63,}/,
        'the mechanism must be truncated to 80 characters: nothing past them may reach the message',
      );
      const expectedEscaped = JSON.stringify(hostileMechanism.slice(0, 80));
      assert.ok(
        error.message.includes(expectedEscaped),
        `the message must carry the mechanism JSON-escaped and truncated to 80 chars: ${JSON.stringify(error.message)}`,
      );
      return true;
    },
  );
});

test('createModelGenerateHypotheses: refuses a cause carrying an unknown key', async () => {
  const createModelGenerateHypotheses = requireRolesExport('createModelGenerateHypotheses');
  const ModelRoleOutputError = requireRolesExport('ModelRoleOutputError');
  const { port } = fakePort([
    {
      hypotheses: [
        {
          id: 'h-1',
          statement: 'the checkout deploy did it',
          cause: { component: 'checkout-service', mechanism: 'config-drift', severity: 'high' },
        },
      ],
    },
  ]);
  const node = createModelGenerateHypotheses({ port, at, mechanisms: MECHANISMS });

  await assert.rejects(
    () => node(initialState()),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError);
      assert.match(error.message, /severity/, `the unknown key must be named: ${error.message}`);
      return true;
    },
  );
});

test('createModelGenerateHypotheses: the system prompt contains exactly the mechanism vocabulary sentence', async () => {
  const createModelGenerateHypotheses = requireRolesExport('createModelGenerateHypotheses');
  const { port, requests } = fakePort([
    {
      hypotheses: [
        {
          id: 'h-1',
          statement: 'the checkout deploy did it',
          cause: { component: 'checkout-service', mechanism: 'config-drift' },
        },
      ],
    },
  ]);
  const node = createModelGenerateHypotheses({ port, at, mechanisms: MECHANISMS });

  await node(initialState());

  assert.equal(requests.length, 1);
  assert.ok(
    requests[0].system.includes("Classify each cause's mechanism as one of: config-drift, capacity-exhaustion."),
    `expected the exact vocabulary sentence in the system prompt: ${JSON.stringify(requests[0].system)}`,
  );
});

/* ============================================================================
 * createModelChallengeHypothesis: a structured cause on the alternative
 * ==========================================================================*/

test("createModelChallengeHypothesis: the provider schema declares a closed cause object on alternative, required, with the mechanism enum equal to the supplied vocabulary exactly", async () => {
  const createModelChallengeHypothesis = requireRolesExport('createModelChallengeHypothesis');
  const { port, requests } = capturingPort();
  const node = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS });

  await node(stateWithLeader(), 'h-1').catch(() => {});

  assert.equal(requests.length, 1);
  const alternative = requests[0].outputSchema.properties.alternative;
  assert.ok(
    alternative.required.includes('cause'),
    `the alternative schema must require cause: ${JSON.stringify(alternative.required)}`,
  );
  assert.deepEqual(
    alternative.properties.cause,
    {
      type: 'object',
      properties: {
        component: { type: 'string' },
        mechanism: { type: 'string', enum: ['config-drift', 'capacity-exhaustion'] },
        trigger: { type: 'string' },
      },
      required: ['component', 'mechanism'],
      additionalProperties: false,
    },
    'the cause object schema must match the closed shape exactly, with the mechanism enum equal to the supplied vocabulary',
  );
});

test('createModelChallengeHypothesis: a valid answer with a cause carrying a trigger returns an alternative carrying that exact cause', async () => {
  const createModelChallengeHypothesis = requireRolesExport('createModelChallengeHypothesis');
  const { port } = fakePort([
    {
      alternative: {
        id: 'alt-1',
        statement: 'the dependency, not the deploy',
        cause: {
          component: 'dependency-pool',
          mechanism: 'capacity-exhaustion',
          trigger: 'the pool hit its ceiling',
        },
      },
      discriminatingTests: [
        { id: 'dt-1', predictionId: 'p-1', tool: 'logs.search', input: {}, cost: 'cheap' },
      ],
    },
  ]);
  const node = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS });

  const result = await node(stateWithLeader(), 'h-1');

  assert.deepEqual(result.alternative, {
    id: 'alt-1',
    statement: 'the dependency, not the deploy',
    createdBy: 'challenge',
    cause: {
      component: 'dependency-pool',
      mechanism: 'capacity-exhaustion',
      trigger: 'the pool hit its ceiling',
    },
  });
  HypothesisSchema.parse(result.alternative);
});

test('createModelChallengeHypothesis: a cause with no trigger carries no own trigger key on the alternative, not trigger: undefined', async () => {
  const createModelChallengeHypothesis = requireRolesExport('createModelChallengeHypothesis');
  const { port } = fakePort([
    {
      alternative: {
        id: 'alt-1',
        statement: 'the dependency, not the deploy',
        cause: { component: 'dependency-pool', mechanism: 'capacity-exhaustion' },
      },
      discriminatingTests: [
        { id: 'dt-1', predictionId: 'p-1', tool: 'logs.search', input: {}, cost: 'cheap' },
      ],
    },
  ]);
  const node = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS });

  const result = await node(stateWithLeader(), 'h-1');

  assert.equal(
    Object.hasOwn(result.alternative.cause, 'trigger'),
    false,
    'an alternative cause with no trigger must not carry an own trigger key at all',
  );
});

test('createModelChallengeHypothesis: refuses an alternative carrying no cause', async () => {
  const createModelChallengeHypothesis = requireRolesExport('createModelChallengeHypothesis');
  const ModelRoleOutputError = requireRolesExport('ModelRoleOutputError');
  const { port } = fakePort([
    {
      alternative: { id: 'alt-1', statement: 'the dependency, not the deploy' },
      discriminatingTests: [
        { id: 'dt-1', predictionId: 'p-1', tool: 'logs.search', input: {}, cost: 'cheap' },
      ],
    },
  ]);
  const node = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS });

  await assert.rejects(() => node(stateWithLeader(), 'h-1'), ModelRoleOutputError);
});

test("createModelChallengeHypothesis: refuses an alternative cause whose mechanism is outside the supplied vocabulary, naming it escaped and truncated to 80 characters", async () => {
  const createModelChallengeHypothesis = requireRolesExport('createModelChallengeHypothesis');
  const ModelRoleOutputError = requireRolesExport('ModelRoleOutputError');
  const hostileMechanism = `"quoted"\nline-two-${'x'.repeat(500)}`;
  assert.ok(hostileMechanism.length > 200, 'the fixture mechanism must exceed 200 characters');
  const { port } = fakePort([
    {
      alternative: {
        id: 'alt-1',
        statement: 'the dependency, not the deploy',
        cause: { component: 'dependency-pool', mechanism: hostileMechanism },
      },
      discriminatingTests: [
        { id: 'dt-1', predictionId: 'p-1', tool: 'logs.search', input: {}, cost: 'cheap' },
      ],
    },
  ]);
  const node = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS });

  await assert.rejects(
    () => node(stateWithLeader(), 'h-1'),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError, `expected a ModelRoleOutputError, got ${error}`);
      assert.ok(
        !error.message.includes('\n'),
        `a raw newline from a hostile mechanism must never reach the message: ${JSON.stringify(error.message)}`,
      );
      assert.doesNotMatch(
        error.message,
        /x{63,}/,
        'the mechanism must be truncated to 80 characters: nothing past them may reach the message',
      );
      const expectedEscaped = JSON.stringify(hostileMechanism.slice(0, 80));
      assert.ok(
        error.message.includes(expectedEscaped),
        `the message must carry the mechanism JSON-escaped and truncated to 80 chars: ${JSON.stringify(error.message)}`,
      );
      return true;
    },
  );
});

test('createModelChallengeHypothesis: refuses an alternative cause carrying an unknown key', async () => {
  const createModelChallengeHypothesis = requireRolesExport('createModelChallengeHypothesis');
  const ModelRoleOutputError = requireRolesExport('ModelRoleOutputError');
  const { port } = fakePort([
    {
      alternative: {
        id: 'alt-1',
        statement: 'the dependency, not the deploy',
        cause: { component: 'dependency-pool', mechanism: 'capacity-exhaustion', severity: 'high' },
      },
      discriminatingTests: [
        { id: 'dt-1', predictionId: 'p-1', tool: 'logs.search', input: {}, cost: 'cheap' },
      ],
    },
  ]);
  const node = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS });

  await assert.rejects(
    () => node(stateWithLeader(), 'h-1'),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError);
      assert.match(error.message, /severity/, `the unknown key must be named: ${error.message}`);
      return true;
    },
  );
});

test('createModelChallengeHypothesis: the system prompt contains exactly the mechanism vocabulary sentence', async () => {
  const createModelChallengeHypothesis = requireRolesExport('createModelChallengeHypothesis');
  const { port, requests } = fakePort([
    {
      alternative: {
        id: 'alt-1',
        statement: 'the dependency, not the deploy',
        cause: { component: 'dependency-pool', mechanism: 'capacity-exhaustion' },
      },
      discriminatingTests: [
        { id: 'dt-1', predictionId: 'p-1', tool: 'logs.search', input: {}, cost: 'cheap' },
      ],
    },
  ]);
  const node = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS });

  await node(stateWithLeader(), 'h-1');

  assert.equal(requests.length, 1);
  assert.ok(
    requests[0].system.includes("Classify each cause's mechanism as one of: config-drift, capacity-exhaustion."),
    `expected the exact vocabulary sentence in the system prompt: ${JSON.stringify(requests[0].system)}`,
  );
});

/* ============================================================================
 * causeMechanismViolation (@aic/domain): one implementation, shared
 * ==========================================================================*/

test('causeMechanismViolation: undefined for a cause whose mechanism is in the vocabulary', () => {
  const causeMechanismViolation = requireDomainExport('causeMechanismViolation');
  assert.equal(
    causeMechanismViolation({ component: 'checkout-service', mechanism: 'config-drift' }, MECHANISMS),
    undefined,
  );
});

test('causeMechanismViolation: a hostile off-vocabulary mechanism (quotes, a newline, 500 chars) is named escaped and truncated to 80 chars', () => {
  const causeMechanismViolation = requireDomainExport('causeMechanismViolation');
  const quoteModelText = requireDomainExport('quoteModelText');
  const hostileMechanism = `"quoted"\nline-two-${'x'.repeat(500)}`;

  const violation = causeMechanismViolation(
    { component: 'checkout-service', mechanism: hostileMechanism },
    MECHANISMS,
  );

  assert.equal(typeof violation, 'string', 'an off-vocabulary mechanism must produce a violation string');
  assert.ok(!violation.includes('\n'), `a raw newline must never reach the violation text: ${violation}`);
  assert.doesNotMatch(violation, /x{63,}/, 'the mechanism must be truncated to 80 characters');
  assert.ok(
    violation.includes(quoteModelText(hostileMechanism)),
    `the violation must carry the mechanism escaped through quoteModelText: ${violation}`,
  );
});

test('causeMechanismViolation: the conclusion role\'s off-vocabulary refusal message carries exactly what causeMechanismViolation returns for the same cause and vocabulary — one implementation', async () => {
  const causeMechanismViolation = requireDomainExport('causeMechanismViolation');
  const createModelProposeConclusion = requireRolesExport('createModelProposeConclusion');
  const ModelRoleOutputError = requireRolesExport('ModelRoleOutputError');

  const cause = { component: 'checkout-service', mechanism: 'not-in-the-supplied-vocabulary' };
  const expected = causeMechanismViolation(cause, MECHANISMS);
  assert.equal(typeof expected, 'string', 'the fixture mechanism must actually violate the vocabulary');

  const state = {
    incident: scopedIncident('incident-cause-violation-conclusion'),
    hypotheses: [{ id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' }],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [
      {
        id: 'e-1',
        trialId: 'trial-1',
        kind: 'deploy',
        source: 'deploy-log',
        observedAt: '2026-01-01T00:00:00.000Z',
        statement: 'checkout-v42 rolled out at 00:00',
        rawRef: 'deploy/42',
      },
    ],
    assessments: [],
    control: {
      runId: 'run-cause-violation-conclusion',
      schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
      statusRulesVersion: STATUS_RULES_VERSION,
      phase: 'concluding',
      maxIterations: 4,
      llmCallBudget: 8,
      reservedChallengeBudget: 2,
      challengeRounds: 0,
      iterationsUsed: 0,
      llmCallsUsed: 0,
      resumeCount: 0,
      humanReview: false,
      stopKind: 'sufficient',
    },
  };
  const { port } = fakePort([
    {
      kind: 'root-cause',
      causes: [{ hypothesisId: 'h-1', cause, evidenceIds: ['e-1'] }],
    },
  ]);
  const node = createModelProposeConclusion({ port, mechanisms: MECHANISMS });

  await assert.rejects(
    () => node(state),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError);
      assert.ok(
        error.message.includes(expected),
        `the role's refusal must carry causeMechanismViolation's own text, not restate it: ${JSON.stringify(error.message)}`,
      );
      return true;
    },
  );
});

test('causeMechanismViolation: generate_hypotheses\' off-vocabulary refusal message carries exactly what causeMechanismViolation returns for the same cause and vocabulary — one implementation', async () => {
  const causeMechanismViolation = requireDomainExport('causeMechanismViolation');
  const createModelGenerateHypotheses = requireRolesExport('createModelGenerateHypotheses');
  const ModelRoleOutputError = requireRolesExport('ModelRoleOutputError');

  const cause = { component: 'checkout-service', mechanism: 'not-in-the-supplied-vocabulary' };
  const expected = causeMechanismViolation(cause, MECHANISMS);
  assert.equal(typeof expected, 'string', 'the fixture mechanism must actually violate the vocabulary');

  const { port } = fakePort([
    { hypotheses: [{ id: 'h-1', statement: 'the checkout deploy did it', cause }] },
  ]);
  const node = createModelGenerateHypotheses({ port, at, mechanisms: MECHANISMS });

  await assert.rejects(
    () => node(initialState()),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError);
      assert.ok(
        error.message.includes(expected),
        `the role's refusal must carry causeMechanismViolation's own text, not restate it: ${JSON.stringify(error.message)}`,
      );
      return true;
    },
  );
});

/* ============================================================================
 * describeMechanismVocabulary (@aic/roles): one sentence, shared
 * ==========================================================================*/

test('describeMechanismVocabulary returns the exact sentence every mechanism-vocabulary role must show', () => {
  const describeMechanismVocabulary = requireRolesExport('describeMechanismVocabulary');
  assert.equal(
    describeMechanismVocabulary(['config-drift', 'capacity-exhaustion']),
    "Classify each cause's mechanism as one of: config-drift, capacity-exhaustion.",
  );
});

test("generate_hypotheses' system prompt contains describeMechanismVocabulary(vocabulary) for the vocabulary it was given", async () => {
  const describeMechanismVocabulary = requireRolesExport('describeMechanismVocabulary');
  const createModelGenerateHypotheses = requireRolesExport('createModelGenerateHypotheses');
  const { port, requests } = fakePort([
    {
      hypotheses: [
        {
          id: 'h-1',
          statement: 'the checkout deploy did it',
          cause: { component: 'checkout-service', mechanism: 'config-drift' },
        },
      ],
    },
  ]);
  const node = createModelGenerateHypotheses({ port, at, mechanisms: MECHANISMS });

  await node(initialState());

  assert.ok(requests[0].system.includes(describeMechanismVocabulary(MECHANISMS)));
});

test("challenge_hypothesis' system prompt contains describeMechanismVocabulary(vocabulary) for the vocabulary it was given", async () => {
  const describeMechanismVocabulary = requireRolesExport('describeMechanismVocabulary');
  const createModelChallengeHypothesis = requireRolesExport('createModelChallengeHypothesis');
  const { port, requests } = fakePort([
    {
      alternative: {
        id: 'alt-1',
        statement: 'the dependency, not the deploy',
        cause: { component: 'dependency-pool', mechanism: 'capacity-exhaustion' },
      },
      discriminatingTests: [
        { id: 'dt-1', predictionId: 'p-1', tool: 'logs.search', input: {}, cost: 'cheap' },
      ],
    },
  ]);
  const node = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS });

  await node(stateWithLeader(), 'h-1');

  assert.ok(requests[0].system.includes(describeMechanismVocabulary(MECHANISMS)));
});

test("propose_conclusion's system prompt contains describeMechanismVocabulary(vocabulary) for the vocabulary it was given", async () => {
  const describeMechanismVocabulary = requireRolesExport('describeMechanismVocabulary');
  const createModelProposeConclusion = requireRolesExport('createModelProposeConclusion');
  const state = {
    incident: scopedIncident('incident-describe-mechanism-vocabulary'),
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: {
      runId: 'run-describe-mechanism-vocabulary',
      schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
      statusRulesVersion: STATUS_RULES_VERSION,
      phase: 'concluding',
      maxIterations: 4,
      llmCallBudget: 8,
      reservedChallengeBudget: 2,
      challengeRounds: 0,
      iterationsUsed: 0,
      llmCallsUsed: 0,
      resumeCount: 0,
      humanReview: false,
      stopKind: 'sufficient',
    },
  };
  const { port, requests } = fakePort([{ kind: 'inconclusive', causes: [] }]);
  const node = createModelProposeConclusion({ port, mechanisms: MECHANISMS });

  await node(state);

  const text = `${requests[0].system}\n${requests[0].prompt}`;
  assert.ok(text.includes(describeMechanismVocabulary(MECHANISMS)));
});

test("the naive role's system prompt contains describeMechanismVocabulary(vocabulary) for the vocabulary it was given", async () => {
  const describeMechanismVocabulary = requireRolesExport('describeMechanismVocabulary');
  const createModelNaiveInvestigation = requireRolesExport('createModelNaiveInvestigation');
  const { port, requests } = fakePort([
    {
      hypotheses: [{ id: 'h-1', statement: 'the checkout deploy did it' }],
      assessments: [],
      conclusion: {
        kind: 'root-cause',
        causes: [
          {
            hypothesisId: 'h-1',
            cause: { component: 'checkout-service', mechanism: 'config-drift' },
            evidenceIds: ['evidence-1'],
          },
        ],
      },
      stopKind: 'sufficient',
    },
  ]);
  const node = createModelNaiveInvestigation({ port, mechanisms: MECHANISMS });

  await node({
    incidentId: 'incident-naive-describe-mechanism-vocabulary',
    entries: [
      {
        status: 'ok',
        tool: 'query-logs',
        input: {},
        evidence: [
          {
            id: 'evidence-1',
            kind: 'deploy',
            source: 'deploy-log',
            observedAt: '2026-01-01T00:00:00.000Z',
            statement: 'checkout-v42 rolled out at 00:00',
          },
        ],
      },
    ],
  });

  assert.ok(requests[0].system.includes(describeMechanismVocabulary(MECHANISMS)));
});

/* ============================================================================
 * CauseDescriptionSchema caps (AIC-123 slice 2): component/mechanism
 * min(1).max(200), trigger max(500) — shared by Hypothesis.cause and
 * CauseClaim.cause
 * ==========================================================================*/

function hypothesisWithCause(cause) {
  return { id: 'h-1', statement: 'a statement', createdBy: 'initial', cause };
}

function causeClaim(cause) {
  return { hypothesisId: 'h-1', cause, evidenceIds: [] };
}

test('CauseDescriptionSchema: a component of exactly 200 characters is accepted, through both HypothesisSchema.cause and CauseClaimSchema.cause', () => {
  const component = 'c'.repeat(200);
  const cause = { component, mechanism: 'm' };
  assert.doesNotThrow(() => HypothesisSchema.parse(hypothesisWithCause(cause)));
  assert.doesNotThrow(() => CauseClaimSchema.parse(causeClaim(cause)));
});

test('CauseDescriptionSchema: a component of 201 characters is refused, through both HypothesisSchema.cause and CauseClaimSchema.cause', () => {
  const component = 'c'.repeat(201);
  const cause = { component, mechanism: 'm' };
  assert.throws(() => HypothesisSchema.parse(hypothesisWithCause(cause)));
  assert.throws(() => CauseClaimSchema.parse(causeClaim(cause)));
});

test('CauseDescriptionSchema: an empty component is refused, through both HypothesisSchema.cause and CauseClaimSchema.cause', () => {
  const cause = { component: '', mechanism: 'm' };
  assert.throws(() => HypothesisSchema.parse(hypothesisWithCause(cause)));
  assert.throws(() => CauseClaimSchema.parse(causeClaim(cause)));
});

test('CauseDescriptionSchema: a mechanism of exactly 200 characters is accepted, through both HypothesisSchema.cause and CauseClaimSchema.cause', () => {
  const mechanism = 'm'.repeat(200);
  const cause = { component: 'c', mechanism };
  assert.doesNotThrow(() => HypothesisSchema.parse(hypothesisWithCause(cause)));
  assert.doesNotThrow(() => CauseClaimSchema.parse(causeClaim(cause)));
});

test('CauseDescriptionSchema: a mechanism of 201 characters is refused, through both HypothesisSchema.cause and CauseClaimSchema.cause', () => {
  const mechanism = 'm'.repeat(201);
  const cause = { component: 'c', mechanism };
  assert.throws(() => HypothesisSchema.parse(hypothesisWithCause(cause)));
  assert.throws(() => CauseClaimSchema.parse(causeClaim(cause)));
});

test('CauseDescriptionSchema: an empty mechanism is refused, through both HypothesisSchema.cause and CauseClaimSchema.cause', () => {
  const cause = { component: 'c', mechanism: '' };
  assert.throws(() => HypothesisSchema.parse(hypothesisWithCause(cause)));
  assert.throws(() => CauseClaimSchema.parse(causeClaim(cause)));
});

test('CauseDescriptionSchema: a trigger of exactly 500 characters is accepted, through both HypothesisSchema.cause and CauseClaimSchema.cause', () => {
  const trigger = 't'.repeat(500);
  const cause = { component: 'c', mechanism: 'm', trigger };
  assert.doesNotThrow(() => HypothesisSchema.parse(hypothesisWithCause(cause)));
  assert.doesNotThrow(() => CauseClaimSchema.parse(causeClaim(cause)));
});

test('CauseDescriptionSchema: a trigger of 501 characters is refused, through both HypothesisSchema.cause and CauseClaimSchema.cause', () => {
  const trigger = 't'.repeat(501);
  const cause = { component: 'c', mechanism: 'm', trigger };
  assert.throws(() => HypothesisSchema.parse(hypothesisWithCause(cause)));
  assert.throws(() => CauseClaimSchema.parse(causeClaim(cause)));
});

/* ============================================================================
 * The cause reaches the roles that run after it
 * ==========================================================================*/

/**
 * The model is shown each hypothesis as the state holds it, so a cause one
 * role wrote is context for every role that runs later. Each prompt is read
 * off the request the role sends; a capturing port stops the role there.
 */
test('a hypothesis cause in state reaches the interpret, challenge and conclusion prompts', async () => {
  const cause = { component: 'checkout-db-endpoint', mechanism: 'config-drift', trigger: 'checkout-v42' };
  const state = stateWithLeader();
  state.hypotheses[0].cause = cause;
  state.control.stopKind = 'sufficient';

  const prompts = [];
  for (const [name, build, call] of [
    ['interpret_residual_evidence', (port) => roles.createModelInterpretResidualEvidence({ port, at }), (node) => node(state)],
    ['challenge_hypothesis', (port) => roles.createModelChallengeHypothesis({ port, mechanisms: MECHANISMS }), (node) => node(state, 'h-1')],
    ['propose_conclusion', (port) => roles.createModelProposeConclusion({ port, mechanisms: MECHANISMS }), (node) => node(state)],
  ]) {
    const { port, requests } = capturingPort();
    await assert.rejects(call(build(port)), /stop here/);
    assert.equal(requests.length, 1, `${name} sends exactly one request`);
    prompts.push([name, requests[0].prompt]);
  }

  for (const [name, prompt] of prompts) {
    for (const value of Object.values(cause)) {
      assert.ok(prompt.includes(JSON.stringify(value)), `${name}'s prompt must show the cause value ${value}`);
    }
  }
});
