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

/**
 * Round-2 rewrite (code-reviewer blocker 1, `test/conclusion-role.test.mjs:375`):
 * the original row's fixture prediction ids were literally `p-supported` and
 * `p-rejected`, so `describeState`'s own serialisation of those ids already
 * put the words "supported"/"rejected" in the prompt — the row proved nothing
 * about the `derived hypothesis statuses` line at all (`assert.match(text,
 * /supported/)` and `/rejected/` passed against the ID text, not the derived
 * STATUS). Deleting the whole prompt line, or computing every status for
 * `hypotheses[0]`, or dropping `id` from each entry, all left the row green.
 *
 * This version's ids (`h-alpha`, `h-beta`, `p-1`, `e-1`, `e-2`) contain no
 * status word, so the only way "rejected" or "weakened" can appear in the
 * prompt is through the `derived hypothesis statuses` line itself, and the
 * assertions below pin the id-status PAIRING (`"id":"h-alpha","status":"…"`)
 * so a status computed for the wrong hypothesis is caught too.
 *
 * The two expected statuses are worked out BY HAND against
 * `BASELINE_STATUS_RULES` (`packages/domain/src/status-rules.ts`) and
 * `deriveHypothesisStatus`'s check order (`packages/domain/src/evaluation.ts`)
 * — this test calls neither: the expectations below are literals, per
 * `.claude/rules/invariants.md` ("the independent-oracle invariant").
 *
 * h-alpha -> 'rejected':
 *   Its only assessment (a-1) has effect 'contradicts' and a defined
 *   predictionId ('p-1'), so the 'rejected' check runs: p-1's own status is
 *   'refuted' (rules.rejected.predictionStatus) and its cited evidence (e-1)
 *   has reliability 'high' (rules.rejected.evidenceReliability). Both match,
 *   so `isRejected` is true. `isRejected` is checked FIRST in
 *   `deriveHypothesisStatus`, before weakened or supported, so nothing else
 *   about h-alpha's assessments can change this.
 *
 * h-beta -> 'weakened':
 *   Its only assessment (a-2) has effect 'contradicts' but NO predictionId,
 *   so the 'rejected' check's own `assessment.predictionId === undefined`
 *   guard makes `isRejected` false for h-beta (it can never see p-1, which
 *   belongs to h-alpha, since `hypothesisAssessments`/`hypothesisPredictions`
 *   are filtered to h-beta only). a-2's strength is 'medium', which IS in
 *   `rules.weakened.contradictionStrengths` (`['medium', 'high']`), so
 *   `hasMaterialContradiction` is true and the status is 'weakened' — the
 *   'supported' branch is never reached because 'weakened' returns first.
 */
test('shows the derived status of every hypothesis, computed the same way deriveHypothesisStatus computes it', async () => {
  const state = baseState();
  state.hypotheses = [
    { id: 'h-alpha', statement: 'the checkout deploy did it', createdBy: 'initial' },
    { id: 'h-beta', statement: 'the dependency upgrade, not the deploy', createdBy: 'initial' },
  ];
  state.predictions = [
    {
      id: 'p-1',
      hypothesisId: 'h-alpha',
      statement: 'if true, the canary check is refuted',
      expectedIfTrue: [],
      expectedIfFalse: [],
      status: 'refuted',
    },
  ];
  state.evidence = [
    {
      id: 'e-1',
      trialId: 'trial-1',
      kind: 'metric',
      source: 'metrics-svc',
      observedAt: '2026-01-01T00:05:00.000Z',
      statement: 'the canary check outcome',
      rawRef: 'metrics/dashboard-1',
      reliability: 'high',
    },
    {
      id: 'e-2',
      trialId: 'trial-2',
      kind: 'metric',
      source: 'metrics-svc',
      observedAt: '2026-01-01T00:06:00.000Z',
      statement: 'the pool utilisation reading',
      rawRef: 'metrics/dashboard-2',
    },
  ];
  state.assessments = [
    {
      id: 'a-1',
      evidenceId: 'e-1',
      hypothesisId: 'h-alpha',
      predictionId: 'p-1',
      effect: 'contradicts',
      strength: 'high',
      rationale: 'the canary check came back negative',
      producedBy: 'rule',
      at: '2026-01-01T00:08:00.000Z',
    },
    {
      id: 'a-2',
      evidenceId: 'e-2',
      hypothesisId: 'h-beta',
      effect: 'contradicts',
      strength: 'medium',
      rationale: 'the pool never came close to its limit',
      producedBy: 'rule',
      at: '2026-01-01T00:08:00.000Z',
    },
  ];

  const EXPECTED_H_ALPHA_STATUS = 'rejected';
  const EXPECTED_H_BETA_STATUS = 'weakened';

  const { port, requests } = fakePort([VALID_ANSWERS_BY_KIND.inconclusive]);
  const node = makeNode({ port });

  await node(state);

  assert.equal(requests.length, 1);
  const text = `${requests[0].system}\n${requests[0].prompt}`;
  assert.match(
    text,
    new RegExp(`"id":"h-alpha","status":"${EXPECTED_H_ALPHA_STATUS}"`),
    'h-alpha must be paired with its own derived status (rejected), not deleted, not unattributed, and not swapped with h-beta\'s',
  );
  assert.match(
    text,
    new RegExp(`"id":"h-beta","status":"${EXPECTED_H_BETA_STATUS}"`),
    'h-beta must be paired with its own derived status (weakened), not deleted, not unattributed, and not swapped with h-alpha\'s',
  );
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

/**
 * security-scanner blocker (round 1, `packages/roles/src/investigation-roles.ts:727`):
 * `cause.mechanism` was interpolated into this refusal RAW, while refusals
 * 1-4 and 6 in the same function all escape and truncate. `CauseClaimSchema`
 * types `mechanism` as an unbounded `z.string()`, so a model that echoes
 * attacker-influenceable incident text back as a mechanism can forge a
 * complete, multi-line second message into operator/CI stderr and a
 * committed evidence record. Fixed the way `conclusion-rules.ts`'s
 * `quoteModelText` (formerly `nameValue`) already fixes the sibling paths: JSON-escaped and truncated to
 * 80 characters.
 */
test('escapes and truncates a hostile cause mechanism before it reaches the refusal message (refusal 5)', async () => {
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const hostileMechanism = `"quoted"\nline-two-${'x'.repeat(500)}`;
  assert.ok(hostileMechanism.length > 500, 'the fixture mechanism must exceed 500 characters');
  const answer = {
    kind: 'root-cause',
    causes: [
      {
        hypothesisId: 'h-1',
        cause: { component: 'checkout-service', mechanism: hostileMechanism },
        evidenceIds: ['e-1'],
      },
    ],
  };
  const node = makeNode({ port: fakePort([answer]).port });

  await assert.rejects(
    () => node(baseState()),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError, `expected a ModelRoleOutputError, got ${error}`);
      assert.equal(error.role, 'propose_conclusion');
      assert.ok(
        !error.message.includes('\n'),
        'a raw newline from a hostile mechanism must never reach the refusal message',
      );
      // The first 80 characters of the fixture hold exactly 62 x's, so a run
      // of 63 or more can only come from the part truncation must drop.
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

/**
 * code-reviewer advisory 5 (round 1): the owner ruling names "evidence
 * belongs to the investigation" explicitly, and `conclusionViolation` already
 * refuses a fabricated evidence id at the domain level
 * (`test/conclusion-rules.test.mjs`) — but nothing in THIS role's own suite
 * exercised the delegation for evidence specifically (only for hypotheses and
 * `tools-unavailable`). This row pins that the role-level refusal fires and
 * names the fabricated id escaped, the same way the domain's own row does.
 */
test('refuses a cause citing evidence the state does not carry, via conclusionViolation (refusal 6)', async () => {
  const answer = {
    kind: 'root-cause',
    causes: [
      {
        hypothesisId: 'h-1',
        cause: { component: 'checkout-service', mechanism: 'config-drift' },
        evidenceIds: ['e-does-not-exist'],
      },
    ],
  };
  const node = makeNode({ port: fakePort([answer]).port });
  await assertRefused(
    node,
    baseState(),
    'a cause citing evidence the state does not carry must be refused at the role level too',
    /e-does-not-exist/,
  );
});

/* -------------------------------------------------------------------------- */
/* Advisory 2: an absent stopKind is a graph invariant, not a model refusal   */
/* -------------------------------------------------------------------------- */

/**
 * code-reviewer advisory 2 (round 1, `investigation-roles.ts:736`): the cast
 * `state.control.stopKind as InvestigationStop` makes an ABSENT stop kind
 * invisible to the type checker, and with it absent `conclusionViolation`'s
 * rule 6 cannot fire (it only refuses `kind: 'no-incident'` when
 * `stopKind === 'tools-unavailable'`, and `undefined !== 'tools-unavailable'`).
 * `stopKind` is a graph-owned invariant — `terminate()` always stamps it
 * before routing here — so its absence is a harness defect, not a model
 * answering badly, and must not be reported as one. It must also be checked
 * BEFORE any port call: asking the model to compose a conclusion the harness
 * cannot even validate afterward would spend a call on a run that was never
 * going to get an answer through.
 */
test('throws a plain harness Error naming stopKind when state.control.stopKind is absent, before any port call', async () => {
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const state = baseState();
  const { stopKind: _stopKind, ...controlWithoutStopKind } = state.control;
  state.control = controlWithoutStopKind;
  const { port, requests } = fakePort([VALID_ANSWERS_BY_KIND.inconclusive]);
  const node = makeNode({ port });

  await assert.rejects(
    () => node(state),
    (error) => {
      assert.ok(
        !(error instanceof ModelRoleOutputError),
        'an absent stopKind is a graph invariant violation, not a model-quality refusal, so it must not be reported as one',
      );
      assert.match(error.message, /stopKind/, `the error must name stopKind: ${error.message}`);
      return true;
    },
    'a state with no control.stopKind must throw before the port is ever asked',
  );
  assert.equal(
    requests.length,
    0,
    'the port must not be called before the stopKind invariant is checked',
  );
});

/* -------------------------------------------------------------------------- */
/* AIC-119 slice E: state.assessments naming unknown ids is a harness fault,  */
/* not a model refusal — and it must not leak raw model text                 */
/* -------------------------------------------------------------------------- */

/**
 * `deriveHypothesisStatus` (`packages/domain/src/evaluation.ts`) throws a
 * plain `Error` naming the offending id VERBATIM when an assessment cites
 * evidence, a hypothesis or a prediction the run does not carry — reachable
 * here whenever `state.assessments` was written before AIC-119 slice D's own
 * validation existed (a checkpoint resumed across that boundary). This role
 * must validate those references itself, BEFORE deriving any hypothesis
 * status and before any port call — the same ordering the stopKind guard
 * above already uses, for the same reason: asking the model to compose a
 * conclusion the harness cannot even validate would spend a call on a run
 * that was never going to get an answer through. The id in the thrown
 * message must go through `quoteModelText` (`@aic/domain`), the same
 * escape-and-truncate `interpret_residual_evidence`'s own refusals already
 * use, rather than `deriveHypothesisStatus`'s raw, unescaped text.
 */
test('an assessment naming evidence the run does not carry throws a plain (non-ModelRoleOutputError) Error before any port call, with no raw newline from a hostile id', async () => {
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const hostileEvidenceId = `"quoted"\nline-two-${'x'.repeat(500)}`;
  const state = baseState({
    assessments: [
      {
        id: 'a-1',
        evidenceId: hostileEvidenceId,
        hypothesisId: 'h-1',
        effect: 'supports',
        strength: 'high',
        rationale: 'because',
        producedBy: 'llm',
        promptVersion: 'reference-roles-prompt-v0.2',
        at: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
  const { port, requests } = fakePort([VALID_ANSWERS_BY_KIND.inconclusive]);
  const node = makeNode({ port });

  await assert.rejects(
    () => node(state),
    (error) => {
      assert.ok(
        !(error instanceof ModelRoleOutputError),
        'a state whose assessments name unknown evidence is a state/harness fault, not a model-quality refusal',
      );
      assert.ok(
        !error.message.includes('\n'),
        `a raw newline from a hostile id must never reach the message: ${JSON.stringify(error.message)}`,
      );
      return true;
    },
    'a state whose assessments cite unknown evidence must throw before the port is ever asked',
  );
  assert.equal(
    requests.length,
    0,
    'the port must not be called before the assessment references are validated',
  );
});

/* -------------------------------------------------------------------------- */
/* Advisory 3: two defensive details, pinned                                  */
/* -------------------------------------------------------------------------- */

/**
 * code-reviewer advisory 3 (round 1): `trigger: ownValue(claimed, 'trigger')`
 * already reads defensively (own-property descriptor, not a plain `[[Get]]`),
 * but nothing exercised it with `Object.prototype.trigger` actually polluted
 * — the existing prototype-pollution row (refusal 4) only pollutes `kind`.
 * This pins that a cause with no OWN `trigger` never picks one up through the
 * prototype chain, even when one is planted there for the duration of the
 * call.
 */
test("reads a cause's trigger only from what it owns, never from Object.prototype", async () => {
  const answer = {
    kind: 'root-cause',
    causes: [
      {
        hypothesisId: 'h-1',
        // No own `trigger` on this cause description.
        cause: { component: 'checkout-service', mechanism: 'config-drift' },
        evidenceIds: ['e-1'],
      },
    ],
  };

  await withPollutedObjectPrototype('trigger', 'a-trigger-the-model-never-supplied', async () => {
    const node = makeNode({ port: fakePort([answer]).port });
    const result = await node(baseState());

    // `Object.hasOwn` is the only sound check here: EVERY plain object
    // inherits whatever is planted on `Object.prototype`, so a plain
    // `cause.trigger === 'a-trigger…'` read would report "leaked" for any
    // object at all while the pollution is in effect, correct code included.
    // `ownValue`'s own-descriptor read is what decides whether the polluted
    // value ever became part of the built cause; a delete-when-undefined
    // cause that came out clean removes it from the object's OWN keys.
    assert.equal(
      Object.hasOwn(result.conclusion.causes[0].cause, 'trigger'),
      false,
      'a cause with no own trigger must not carry one built from Object.prototype',
    );
  });
});

/**
 * code-reviewer advisory 3 (round 1): `const vocabulary =
 * Object.freeze([...mechanisms])` copies the caller's array at NODE-CREATION
 * time, so mutating the caller's own array afterward must not widen what the
 * running node accepts. Unpinned before this row: nothing drove the node
 * with a mutable caller array and mutated it after creation.
 */
test('copies the mechanism vocabulary at creation time, so a mechanism added to the caller array afterward is still refused', async () => {
  const createModelProposeConclusion = requireExport('createModelProposeConclusion');
  const mutableMechanisms = ['config-drift', 'capacity-exhaustion'];
  const answer = {
    kind: 'root-cause',
    causes: [
      {
        hypothesisId: 'h-1',
        cause: { component: 'checkout-service', mechanism: 'added-after-creation' },
        evidenceIds: ['e-1'],
      },
    ],
  };
  const { port } = fakePort([answer]);
  const node = createModelProposeConclusion({ mechanisms: mutableMechanisms, port });
  mutableMechanisms.push('added-after-creation');

  await assertRefused(
    node,
    baseState(),
    'a mechanism added to the caller array after the node was created must still be refused: the vocabulary is copied at creation time',
    /mechanism/i,
  );
});
