/**
 * AIC-119 slice D: `propose_conclusion`, the fourth model role — evidence-
 * constrained conclusion composition.
 *
 * Same discipline as `roles-model-nodes.test.mjs` and `naive-role.test.mjs`:
 * every assertion here runs against a FAKE `ModelPort`, so the whole contract
 * is decidable with no network and no credential. Nothing here is a claim
 * about model QUALITY — it pins the contract `createModelProposeConclusion`
 * must satisfy whatever the model answers: one completion, no retry, every
 * value crossing the domain's schemas and `conclusionViolation`
 * (`@aic/domain`), and no provenance or scenario-identifying text reaching
 * the model that the role does not put there on purpose.
 *
 * `createModelProposeConclusion` does not exist yet
 * (`packages/roles/src/investigation-roles.ts`); every row below fails today
 * because `requireExport` cannot find it, or (for the two rows that read
 * `@aic/domain` exports the domain-hardening slice adds) because those exports
 * do not exist either.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IncidentConclusionSchema,
  INCIDENT_STATE_SCHEMA_VERSION,
  STATUS_RULES_VERSION,
  deriveHypothesisStatus,
} from '@aic/domain';
import * as roles from '@aic/roles';

import { withPollutedObjectPrototype } from './fixtures/prototype-decoy.mjs';
import { scopedIncident } from './fixtures/scoped-incident.mjs';

function requireExport(name) {
  assert.ok(roles[name] !== undefined, `@aic/roles must export ${name}`);
  return roles[name];
}

/**
 * A port that answers with a scripted body and records what it was asked, in
 * the same shape `roles-model-nodes.test.mjs`'s and `naive-role.test.mjs`'s
 * `fakePort` use. `answers` is consumed in order, so a test expecting one
 * call fails loudly on a second rather than replaying the last answer
 * forever — which is exactly the shape that would hide a retry.
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

/** The closed root-cause mechanism vocabulary this suite exercises with. */
const MECHANISMS = Object.freeze(['config-drift', 'capacity-exhaustion']);

/** A realistic IncidentState with two hypotheses and two evidence items to cite. */
function baseState(overrides = {}) {
  return {
    incident: scopedIncident('incident-conclusion-role'),
    hypotheses: [
      { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
      { id: 'h-2', statement: 'the dependency upgrade, not the deploy', createdBy: 'initial' },
    ],
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
      {
        id: 'e-2',
        trialId: 'trial-2',
        kind: 'metric',
        source: 'metrics-svc',
        observedAt: '2026-01-01T00:05:00.000Z',
        statement: 'latency spiked at 00:05',
        rawRef: 'metrics/dashboard-9',
      },
    ],
    assessments: [],
    control: {
      runId: 'run-conclusion-role',
      schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
      statusRulesVersion: STATUS_RULES_VERSION,
      phase: 'concluding',
      maxIterations: 4,
      llmCallBudget: 8,
      reservedChallengeBudget: 2,
      challengeRounds: 1,
      iterationsUsed: 2,
      llmCallsUsed: 3,
      resumeCount: 0,
      humanReview: false,
      stopKind: 'sufficient',
    },
    ...overrides,
  };
}

function makeNode(overrides = {}) {
  const createModelProposeConclusion = requireExport('createModelProposeConclusion');
  return createModelProposeConclusion({ mechanisms: MECHANISMS, ...overrides });
}

/* -------------------------------------------------------------------------- */
/* A valid answer of each conclusion kind                                     */
/* -------------------------------------------------------------------------- */

const VALID_ANSWERS_BY_KIND = {
  'root-cause': {
    kind: 'root-cause',
    causes: [
      {
        hypothesisId: 'h-1',
        cause: { component: 'checkout-service', mechanism: 'config-drift' },
        evidenceIds: ['e-1'],
      },
    ],
  },
  'multiple-causes': {
    kind: 'multiple-causes',
    causes: [
      {
        hypothesisId: 'h-1',
        cause: { component: 'checkout-service', mechanism: 'config-drift' },
        evidenceIds: ['e-1'],
      },
      {
        hypothesisId: 'h-2',
        cause: { component: 'dependency-pool', mechanism: 'capacity-exhaustion' },
        evidenceIds: ['e-2'],
      },
    ],
  },
  inconclusive: { kind: 'inconclusive', causes: [] },
  'no-incident': { kind: 'no-incident', causes: [] },
};

for (const [kind, answer] of Object.entries(VALID_ANSWERS_BY_KIND)) {
  test(`produces a '${kind}' conclusion the domain schema accepts and declares the call it made`, async () => {
    const { port, requests } = fakePort([answer]);
    const node = makeNode({ port });

    const result = await node(baseState());

    assert.deepEqual(
      result.conclusion,
      IncidentConclusionSchema.parse(answer),
      'the returned conclusion must equal the domain-parsed answer',
    );
    assert.equal(
      result.declaredLlmCalls,
      1,
      'the graph counts consumption only through declaredLlmCalls',
    );
    assert.equal(requests.length, 1);
  });
}

/* -------------------------------------------------------------------------- */
/* Exactly one completion per invocation, no retry on refusal                 */
/* -------------------------------------------------------------------------- */

test('makes exactly one port call for a valid answer', async () => {
  const { port, requests } = fakePort([VALID_ANSWERS_BY_KIND['root-cause']]);
  const node = makeNode({ port });

  await node(baseState());

  assert.equal(requests.length, 1);
});

test('does not retry when the answer is refused: the port is still called exactly once', async () => {
  const answer = {
    kind: 'root-cause',
    causes: [
      {
        hypothesisId: 'h-does-not-exist',
        cause: { component: 'checkout-service', mechanism: 'config-drift' },
        evidenceIds: ['e-1'],
      },
    ],
  };
  const { port, requests } = fakePort([answer]);
  const node = makeNode({ port });

  await assert.rejects(() => node(baseState()));

  assert.equal(
    requests.length,
    1,
    'a refused answer must not trigger a second, repair-seeking call: there is no hidden repair round',
  );
});

/* -------------------------------------------------------------------------- */
/* Sampling: no temperature field                                             */
/* -------------------------------------------------------------------------- */

test('sends no temperature field, so this role samples exactly as every other role does', async () => {
  const { port, requests } = fakePort([VALID_ANSWERS_BY_KIND['root-cause']]);
  const node = makeNode({ port });

  await node(baseState());

  assert.equal(requests.length, 1);
  assert.equal(
    Object.hasOwn(requests[0], 'temperature'),
    false,
    'the request object must carry no own temperature property',
  );
});

/* -------------------------------------------------------------------------- */
/* The prompt: mechanism vocabulary, stop kind, challenge rounds, derived     */
/* hypothesis statuses                                                        */
/* -------------------------------------------------------------------------- */

test("shows the model the mechanism vocabulary, exactly as naive-role's sentence reads, and the stop kind as context", async () => {
  const { port, requests } = fakePort([VALID_ANSWERS_BY_KIND.inconclusive]);
  const node = makeNode({ port });

  await node(baseState());

  assert.equal(requests.length, 1);
  const text = `${requests[0].system}\n${requests[0].prompt}`;
  assert.match(
    text,
    /Classify each cause's mechanism as one of: config-drift, capacity-exhaustion\./,
    "the mechanism vocabulary sentence must read exactly as naive-role's does",
  );
  assert.match(
    text,
    /sufficient/,
    'the stop kind must reach the model as context (state.control.stopKind)',
  );
});

test('shows a different prompt when challengeRounds differs, so the round count reaches the model as context', async () => {
  const first = fakePort([VALID_ANSWERS_BY_KIND.inconclusive]);
  const nodeA = makeNode({ port: first.port });
  const stateA = baseState();
  stateA.control = { ...stateA.control, challengeRounds: 0 };
  await nodeA(stateA);

  const second = fakePort([VALID_ANSWERS_BY_KIND.inconclusive]);
  const nodeB = makeNode({ port: second.port });
  const stateB = baseState();
  stateB.control = { ...stateB.control, challengeRounds: 2 };
  await nodeB(stateB);

  assert.notEqual(
    `${first.requests[0].system}\n${first.requests[0].prompt}`,
    `${second.requests[0].system}\n${second.requests[0].prompt}`,
    'a state whose only difference is control.challengeRounds must still reach the model differently: the stop kind is read only as context, but the round count must still be shown',
  );
});

test('shows the derived status of every hypothesis, computed the same way deriveHypothesisStatus computes it', async () => {
  const state = baseState();
  state.predictions = [
    {
      id: 'p-supported',
      hypothesisId: 'h-1',
      statement: 'if true, latency recovers after rollback',
      expectedIfTrue: [],
      expectedIfFalse: [],
      status: 'confirmed',
    },
    {
      id: 'p-rejected',
      hypothesisId: 'h-2',
      statement: 'if true, the pool exhausts under load',
      expectedIfTrue: [],
      expectedIfFalse: [],
      status: 'refuted',
    },
  ];
  state.evidence = [
    ...state.evidence,
    {
      id: 'e-3',
      trialId: 'trial-3',
      kind: 'metric',
      source: 'metrics-svc',
      observedAt: '2026-01-01T00:06:00.000Z',
      statement: 'latency recovered after rollback',
      rawRef: 'metrics/dashboard-11',
      reliability: 'high',
    },
  ];
  state.assessments = [
    {
      id: 'a-1',
      evidenceId: 'e-1',
      hypothesisId: 'h-1',
      predictionId: 'p-supported',
      effect: 'supports',
      strength: 'high',
      rationale: 'matches the rollback timeline',
      producedBy: 'rule',
      at: '2026-01-01T00:08:00.000Z',
    },
    {
      id: 'a-2',
      evidenceId: 'e-2',
      hypothesisId: 'h-1',
      predictionId: 'p-supported',
      effect: 'supports',
      strength: 'high',
      rationale: 'independently corroborates the rollback timeline',
      producedBy: 'rule',
      at: '2026-01-01T00:08:00.000Z',
    },
    {
      id: 'a-3',
      evidenceId: 'e-3',
      hypothesisId: 'h-2',
      predictionId: 'p-rejected',
      effect: 'contradicts',
      strength: 'high',
      rationale: 'the pool never exhausted',
      producedBy: 'rule',
      at: '2026-01-01T00:08:00.000Z',
    },
  ];

  const expectedH1Status = deriveHypothesisStatus({
    hypothesisId: 'h-1',
    predictions: state.predictions,
    assessments: state.assessments,
    evidence: state.evidence,
  });
  const expectedH2Status = deriveHypothesisStatus({
    hypothesisId: 'h-2',
    predictions: state.predictions,
    assessments: state.assessments,
    evidence: state.evidence,
  });
  // Fixture sanity, checked against the SAME domain function production is
  // specified to call — this is a content-derivation check, not a security or
  // governance mechanism, so deriveHypothesisStatus is not a second, competing
  // oracle here: it is the one recipe both the fixture and the role must agree
  // with (per the spec, "computed with deriveHypothesisStatus from @aic/domain").
  assert.equal(expectedH1Status, 'supported', 'fixture sanity: h-1 must derive to supported');
  assert.equal(expectedH2Status, 'rejected', 'fixture sanity: h-2 must derive to rejected');

  const { port, requests } = fakePort([VALID_ANSWERS_BY_KIND.inconclusive]);
  const node = makeNode({ port });

  await node(state);

  assert.equal(requests.length, 1);
  const text = `${requests[0].system}\n${requests[0].prompt}`;
  assert.match(text, new RegExp(expectedH1Status), 'the derived status for h-1 (supported) must reach the model');
  assert.match(text, new RegExp(expectedH2Status), 'the derived status for h-2 (rejected) must reach the model');
});

/* -------------------------------------------------------------------------- */
/* Refusals 1-6, checked in the order the spec declares them                  */
/* -------------------------------------------------------------------------- */

async function assertRefused(node, state, description, messagePattern) {
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  await assert.rejects(
    () => node(state),
    (error) => {
      assert.ok(
        error instanceof ModelRoleOutputError,
        `${description}: expected a ModelRoleOutputError, got ${error}`,
      );
      assert.equal(
        error.role,
        'propose_conclusion',
        `${description}: the refusal must name the propose_conclusion role`,
      );
      if (messagePattern) {
        assert.match(error.message, messagePattern, `${description}: ${error.message}`);
      }
      return true;
    },
    description,
  );
}

/* (1) truncated completion */
test('refuses a truncated completion as a truncation, not as malformed output (refusal 1)', async () => {
  const truncating = {
    async complete() {
      return {
        text: '{"kind":"root-cause","causes":[',
        modelId: 'claude-under-test',
        usage: { inputTokens: 10, outputTokens: 4096 },
        stopReason: 'max_tokens',
      };
    },
  };
  const node = makeNode({ port: truncating });
  await assertRefused(
    node,
    baseState(),
    'a completion the provider cut off at the token budget',
    /truncat|max_tokens|token budget/i,
  );
});

/* (2) unparseable JSON */
test('refuses an answer that carries no JSON document at all (refusal 2)', async () => {
  const { port } = fakePort(['I would rather not answer that.']);
  const node = makeNode({ port });
  await assertRefused(node, baseState(), 'an answer with no JSON document', /no JSON document/);
});

test('refuses an answer whose braces do not contain valid JSON (refusal 2)', async () => {
  const { port } = fakePort(['{"kind": "root-cause", causes: []}']);
  const node = makeNode({ port });
  await assertRefused(node, baseState(), 'malformed JSON between the braces', /not parseable JSON/);
});

/* (3) unknown keys at any level */
test('refuses an unknown key on the top-level answer, on a cause, and on a cause description (refusal 3)', async () => {
  const onTop = {
    kind: 'root-cause',
    causes: [
      { hypothesisId: 'h-1', cause: { component: 'checkout-service', mechanism: 'config-drift' }, evidenceIds: ['e-1'] },
    ],
    confidence: 0.9,
  };
  await assertRefused(
    makeNode({ port: fakePort([onTop]).port }),
    baseState(),
    'an unknown top-level key must be refused, not dropped',
    /confidence/,
  );

  const onCause = {
    kind: 'root-cause',
    causes: [
      {
        hypothesisId: 'h-1',
        cause: { component: 'checkout-service', mechanism: 'config-drift' },
        evidenceIds: ['e-1'],
        weight: 1,
      },
    ],
  };
  await assertRefused(
    makeNode({ port: fakePort([onCause]).port }),
    baseState(),
    'an unknown key on a cause must be refused, not dropped',
    /weight/,
  );

  const onDescription = {
    kind: 'root-cause',
    causes: [
      {
        hypothesisId: 'h-1',
        cause: { component: 'checkout-service', mechanism: 'config-drift', severity: 'high' },
        evidenceIds: ['e-1'],
      },
    ],
  };
  await assertRefused(
    makeNode({ port: fakePort([onDescription]).port }),
    baseState(),
    "an unknown key on a cause's description must be refused, not dropped",
    /severity/,
  );
});

/* (4) an own-read rebuild, then IncidentConclusionSchema parse */
test('refuses an answer the domain schema does not accept, once rebuilt from its own properties (refusal 4)', async () => {
  const missingComponent = {
    kind: 'root-cause',
    causes: [{ hypothesisId: 'h-1', cause: { mechanism: 'config-drift' }, evidenceIds: ['e-1'] }],
  };
  const node = makeNode({ port: fakePort([missingComponent]).port });
  await assertRefused(node, baseState(), 'a cause missing the required component field', null);
});

test('reads the answer only from what it owns, never from Object.prototype (refusal 4)', async () => {
  const withoutKind = { causes: [] };
  await withPollutedObjectPrototype('kind', 'root-cause', async () => {
    const node = makeNode({ port: fakePort([withoutKind]).port });
    await assertRefused(
      node,
      baseState(),
      'an inherited kind must not stand in for the answer the model did not give',
      null,
    );
  });
});

/* (5) a mechanism outside the vocabulary */
test('refuses a cause mechanism outside the supplied vocabulary (refusal 5)', async () => {
  const answer = {
    kind: 'root-cause',
    causes: [
      {
        hypothesisId: 'h-1',
        cause: { component: 'checkout-service', mechanism: 'not-in-the-supplied-vocabulary' },
        evidenceIds: ['e-1'],
      },
    ],
  };
  const node = makeNode({ port: fakePort([answer]).port });
  await assertRefused(
    node,
    baseState(),
    'a mechanism outside the supplied vocabulary must be refused, not passed through',
    /mechanism/i,
  );
});

/* (6) conclusionViolation({...}) reports a reason */
test('refuses a cause naming a hypothesis the state does not carry, via conclusionViolation (refusal 6)', async () => {
  const answer = {
    kind: 'root-cause',
    causes: [
      {
        hypothesisId: 'h-does-not-exist',
        cause: { component: 'checkout-service', mechanism: 'config-drift' },
        evidenceIds: ['e-1'],
      },
    ],
  };
  const node = makeNode({ port: fakePort([answer]).port });
  await assertRefused(
    node,
    baseState(),
    'a cause naming a hypothesis the state does not carry',
    /hypothes/i,
  );
});

test("refuses a 'no-incident' conclusion under stopKind 'tools-unavailable', via conclusionViolation (refusal 6)", async () => {
  const state = baseState();
  state.control = { ...state.control, stopKind: 'tools-unavailable' };
  const node = makeNode({ port: fakePort([VALID_ANSWERS_BY_KIND['no-incident']]).port });
  await assertRefused(
    node,
    state,
    "a 'no-incident' conclusion under stopKind 'tools-unavailable' must be refused",
    /tools-unavailable/i,
  );
});
