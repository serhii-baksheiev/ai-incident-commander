/**
 * AIC-94, steps 3 and 4: the three reference-model-backed investigation roles.
 *
 * Every assertion here runs against a FAKE port. The roles are written to
 * `ModelPort`, which names no provider, so the whole role layer is decidable
 * with no network and no credential — which is why this file needs neither.
 *
 * ⚠ That says nothing about the REPOSITORY. A real model has since executed
 * these roles; the records are committed under `docs/evidence/final-evaluation/`.
 * An earlier version of this sentence read "an environment that has neither",
 * which described the whole environment and stopped being true. It was the third
 * wording of one stale fact and the last of them found, by `prose-reviewer`, in
 * the round after a README paragraph claimed the sweep for it was finished.
 *
 * Nothing in this file is a claim about model QUALITY. It pins the contract the
 * roles must satisfy whatever the model says: every value crosses the domain's
 * `strictObject` schemas, the two wrapped roles declare their consumption
 * through `declaredLlmCalls`, and the challenge role's consumption reaches the
 * ledger because the graph gives it no channel.
 */
import { readFileSync } from 'node:fs';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EvidenceAssessmentSchema,
  HypothesisSchema,
  INCIDENT_STATE_SCHEMA_VERSION,
  InvestigationTestSchema,
  STATUS_RULES_VERSION,
} from '@aic/domain';
import * as domain from '@aic/domain';
import { createInvestigationGraph } from '@aic/graph';
import * as graph from '@aic/graph';
import * as roles from '@aic/roles';

import { TEST_PRIMARY_SCOPE, scopedIncident } from './fixtures/scoped-incident.mjs';

const lifecycleNodes = [
  'normalize_incident',
  'collect_baseline',
  'generate_hypotheses',
  'derive_predictions',
  'plan_investigation',
  'execute_investigation',
  'evaluate_predictions',
  'interpret_residual_evidence',
  'derive_hypothesis_state',
  'termination_check',
  'challenge_hypothesis',
  'propose_conclusion',
];

const initialState = () => ({
  incident: scopedIncident('incident-model-roles'),
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
    runId: 'run-model-roles',
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
});

function requireExport(name) {
  assert.ok(roles[name] !== undefined, `@aic/roles must export ${name}`);
  return roles[name];
}

/**
 * AIC-119 slice E: the graph arm's prompt set changed (a fourth role,
 * `propose_conclusion`, plus the interpret id-contract sentence below), so
 * the version this module ships bumps with it — the same reasoning
 * `docs/evidence/preregistration/` records under a new dated file rather than
 * an edit to the v0.2 one.
 *
 * AIC-119 slice 5 (owner ruling D1, item 6): the prompt set changed again —
 * `propose_conclusion`'s system prompt now also carries the generated
 * status-rules definition sentences (`describeStatusRules`,
 * `conclusion-role.test.mjs` › "propose_conclusion's system prompt contains
 * every sentence describeStatusRules(STATUS_RULES[STATUS_RULES_VERSION])
 * returns") — so the pin moved from `reference-roles-prompt-v0.3` to
 * `reference-roles-prompt-v0.4`.
 *
 * AIC-123 slice 2: the prompt set changed a third time — `generate_hypotheses`
 * and `challenge_hypothesis` now emit a structured `cause` on every hypothesis
 * and alternative, and their system prompts carry the mechanism vocabulary
 * sentence `describeMechanismVocabulary` builds, the same sentence
 * `propose_conclusion`'s prompt already carried. The pin moved to
 * `reference-roles-prompt-v0.5`, the same version `conclusion-role.test.mjs`
 * › "REFERENCE_PROMPT_VERSION is reference-roles-prompt-v0.5" pinned.
 *
 * AIC-143: the prompt set changes a fourth time — `challenge_hypothesis`'s
 * system prompt now also carries `describeRequestVocabulary(requestVocabulary)`
 * right after the answer-shape line, naming the closed tool/input-key
 * vocabulary a discriminating test may use. The pin moves again, to
 * `reference-roles-prompt-v0.6`, the same version `conclusion-role.test.mjs`
 * › "REFERENCE_PROMPT_VERSION is reference-roles-prompt-v0.6" pins.
 */
test('REFERENCE_PROMPT_VERSION is reference-roles-prompt-v0.6', () => {
  assert.equal(requireExport('REFERENCE_PROMPT_VERSION'), 'reference-roles-prompt-v0.6');
});

/**
 * A port that answers with a scripted body and records what it was asked.
 *
 * `answers` is consumed in order, so a test that expects two calls fails loudly
 * on a third rather than replaying the last answer forever.
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
        assert.ok(next !== undefined, 'the fake port ran out of scripted answers');
        return {
          text: typeof next === 'string' ? next : JSON.stringify(next),
          modelId: 'claude-under-test',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    },
  };
}

const at = () => '2026-01-01T01:00:00.000Z';

/**
 * AIC-123 slice 2: the closed root-cause mechanism vocabulary this suite
 * exercises `generate_hypotheses` and `challenge_hypothesis` with — the same
 * shape `conclusion-role.test.mjs` and `naive-role.test.mjs` already use for
 * the other two mechanism-vocabulary roles.
 */
const MECHANISMS = Object.freeze(['config-drift', 'capacity-exhaustion']);

/**
 * AIC-143: the closed request vocabulary `createModelChallengeHypothesis` now
 * requires, built the same way `scripts/lane-arms.mjs` and
 * `apps/cli/src/commands/investigate.ts` build it —
 * `routeRequestVocabulary(INVESTIGATION_ROUTES)` (`@aic/domain` /
 * `@aic/graph`). The optional call is deliberate: until `@aic/domain` ships
 * `routeRequestVocabulary`, this stays `undefined` rather than crashing every
 * other row in this file at import time.
 */
const REQUEST_VOCABULARY = domain.routeRequestVocabulary?.(graph.INVESTIGATION_ROUTES);

/* -------------------------------------------------------------------------- */
/* generate_hypotheses                                                        */
/* -------------------------------------------------------------------------- */

test('produces hypotheses the domain schema accepts and declares the call it made', async () => {
  const createModelGenerateHypotheses = requireExport('createModelGenerateHypotheses');
  const { port, requests } = fakePort([
    {
      hypotheses: [
        {
          id: 'h-1',
          statement: 'the checkout deploy changed the db endpoint',
          cause: { component: 'checkout-service', mechanism: 'config-drift' },
        },
        {
          id: 'h-2',
          statement: 'the dependency upgrade broke pooling',
          cause: { component: 'dependency-pool', mechanism: 'capacity-exhaustion' },
        },
      ],
    },
  ]);
  const node = createModelGenerateHypotheses({ port, at, mechanisms: MECHANISMS });

  const update = await node(initialState());

  assert.deepEqual(update.hypotheses, [
    {
      id: 'h-1',
      statement: 'the checkout deploy changed the db endpoint',
      createdBy: 'initial',
      cause: { component: 'checkout-service', mechanism: 'config-drift' },
    },
    {
      id: 'h-2',
      statement: 'the dependency upgrade broke pooling',
      createdBy: 'initial',
      cause: { component: 'dependency-pool', mechanism: 'capacity-exhaustion' },
    },
  ]);
  for (const hypothesis of update.hypotheses) {
    HypothesisSchema.parse(hypothesis);
  }
  assert.equal(
    update.declaredLlmCalls,
    1,
    'the graph counts consumption only through declaredLlmCalls',
  );
  assert.equal(requests.length, 1);
  assert.match(
    requests[0].prompt,
    /checkout-v42/,
    'the role must show the model the evidence the state carries',
  );
});

/**
 * AIC-96 slice 2: `describeState` serializes `state.incident` verbatim into
 * the prompt (`packages/roles/src/investigation-roles.ts`), so a
 * `primaryScope` added to that incident reaches the model unless the
 * projection is taught to strip it. The scope decides which Service and
 * Environment an action runs against — the model has no business reading it,
 * let alone deciding from it.
 */
test('does not show the model the incident primaryScope, only its id', async () => {
  const createModelGenerateHypotheses = requireExport('createModelGenerateHypotheses');
  const { port, requests } = fakePort([
    {
      hypotheses: [
        {
          id: 'h-1',
          statement: 'a plausible cause',
          cause: { component: 'checkout-service', mechanism: 'config-drift' },
        },
      ],
    },
  ]);
  const node = createModelGenerateHypotheses({ port, at, mechanisms: MECHANISMS });

  await node(initialState());

  assert.equal(requests.length, 1);
  assert.match(
    requests[0].prompt,
    /incident-model-roles/,
    'the incident id must still reach the model: this is not a test that the incident disappears',
  );
  assert.doesNotMatch(
    requests[0].prompt,
    /primaryScope/,
    'the primaryScope key must not reach the model prompt',
  );
  assert.doesNotMatch(
    requests[0].prompt,
    new RegExp(TEST_PRIMARY_SCOPE.serviceId),
    'the scope serviceId must not reach the model prompt',
  );
  assert.doesNotMatch(
    requests[0].prompt,
    new RegExp(TEST_PRIMARY_SCOPE.environmentId),
    'the scope environmentId must not reach the model prompt',
  );
});

test('refuses a hypothesis id the run already carries, rather than overwriting it', async () => {
  // The graph's reducer is `upsertById`, which REPLACES at a matching id rather
  // than merging, so a model naming an existing id overwrites that hypothesis
  // outright — including one a human added. A human `reject` on conclusion
  // review routes back through this node with state populated, and the prompt
  // shows the model every existing id, so incident text an attacker can
  // influence is enough to aim it. Found by `security-scanner` at the AIC-94
  // gate; both sibling producers already refused this shape.
  const createModelGenerateHypotheses = requireExport('createModelGenerateHypotheses');
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const state = initialState();
  const existing = {
    id: 'h-existing',
    statement: 'the hypothesis already under investigation',
    createdBy: 'initial',
  };
  state.hypotheses = [...state.hypotheses, existing];

  const { port } = fakePort([
    {
      hypotheses: [
        {
          id: 'h-existing',
          statement: 'hijacked',
          cause: { component: 'checkout-service', mechanism: 'config-drift' },
        },
      ],
    },
  ]);
  const node = createModelGenerateHypotheses({ port, at, mechanisms: MECHANISMS });

  await assert.rejects(
    () => node(state),
    (error) =>
      error instanceof ModelRoleOutputError &&
      /already carries: "h-existing"/.test(error.message),
    'the refusal must name the id it refused on',
  );
});

test('refuses two hypotheses the model gave the same id', async () => {
  const createModelGenerateHypotheses = requireExport('createModelGenerateHypotheses');
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const { port } = fakePort([
    {
      hypotheses: [
        {
          id: 'h-1',
          statement: 'the first',
          cause: { component: 'checkout-service', mechanism: 'config-drift' },
        },
        {
          id: 'h-1',
          statement: 'the second, which would replace the first',
          cause: { component: 'checkout-service', mechanism: 'config-drift' },
        },
      ],
    },
  ]);
  const node = createModelGenerateHypotheses({ port, at, mechanisms: MECHANISMS });

  await assert.rejects(() => node(initialState()), ModelRoleOutputError);
});

test('refuses a hypothesis set the domain schema does not accept', async () => {
  const createModelGenerateHypotheses = requireExport('createModelGenerateHypotheses');
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const { port } = fakePort([{ hypotheses: [{ id: 'h-1' }] }]);
  const node = createModelGenerateHypotheses({ port, at, mechanisms: MECHANISMS });

  await assert.rejects(() => node(initialState()), ModelRoleOutputError);
});

test('reads a JSON answer the model wrapped in prose or a fenced block', async () => {
  const createModelGenerateHypotheses = requireExport('createModelGenerateHypotheses');
  const { port } = fakePort([
    'Here is my answer:\n```json\n{"hypotheses":[{"id":"h-1","statement":"a cause","cause":{"component":"checkout-service","mechanism":"config-drift"}}]}\n```\nHope that helps.',
  ]);
  const node = createModelGenerateHypotheses({ port, at, mechanisms: MECHANISMS });

  const update = await node(initialState());

  assert.deepEqual(update.hypotheses, [
    {
      id: 'h-1',
      statement: 'a cause',
      createdBy: 'initial',
      cause: { component: 'checkout-service', mechanism: 'config-drift' },
    },
  ]);
});

test('refuses an answer that carries no JSON document at all', async () => {
  const createModelGenerateHypotheses = requireExport('createModelGenerateHypotheses');
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const { port } = fakePort(['I would rather not answer that.']);
  const node = createModelGenerateHypotheses({ port, at, mechanisms: MECHANISMS });

  await assert.rejects(() => node(initialState()), ModelRoleOutputError);
});

/* -------------------------------------------------------------------------- */
/* interpret_residual_evidence                                                */
/* -------------------------------------------------------------------------- */

test('stamps every assessment as llm-produced and carries the prompt version', async () => {
  const createModelInterpretResidualEvidence = requireExport(
    'createModelInterpretResidualEvidence',
  );
  const { port } = fakePort([
    {
      assessments: [
        {
          id: 'a-1',
          evidenceId: 'evidence-1',
          hypothesisId: 'h-1',
          effect: 'supports',
          strength: 'high',
          rationale: 'the rollout time matches the error onset',
        },
      ],
    },
  ]);
  const promptVersion = 'reference-prompt-under-test';
  const node = createModelInterpretResidualEvidence({ port, promptVersion, at });
  const state = initialState();
  state.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
  ];

  const update = await node(state);

  assert.deepEqual(update.assessments, [
    {
      id: 'a-1',
      evidenceId: 'evidence-1',
      hypothesisId: 'h-1',
      effect: 'supports',
      strength: 'high',
      rationale: 'the rollout time matches the error onset',
      producedBy: 'llm',
      promptVersion,
      at: at(),
    },
  ]);
  EvidenceAssessmentSchema.parse(update.assessments[0]);
  assert.equal(update.declaredLlmCalls, 1);
});

/**
 * AIC-119 slice E: the refusal for a fabricated evidenceId/hypothesisId/
 * predictionId landed in #127 (see the three "refuses an assessment whose …"
 * rows below), and the model was never told the rule exists. The system
 * prompt must now say so: every assessment names an evidenceId, hypothesisId
 * and (optional) predictionId that the state below actually shows, and any
 * other id is refused.
 */
test('the system prompt states the id contract: an assessment must name an evidenceId, hypothesisId and (optional) predictionId shown in the state below, and any other id is refused', async () => {
  const createModelInterpretResidualEvidence = requireExport(
    'createModelInterpretResidualEvidence',
  );
  const { port, requests } = fakePort([{ assessments: [] }]);
  const node = createModelInterpretResidualEvidence({ port, at });

  await node(initialState());

  assert.equal(requests.length, 1);
  const { system } = requests[0];
  assert.match(system, /evidenceId/, 'the id-contract sentence must name evidenceId');
  assert.match(system, /hypothesisId/, 'the id-contract sentence must name hypothesisId');
  assert.match(
    system,
    /predictionId/,
    'the id-contract sentence must name predictionId, the optional one',
  );
  assert.match(
    system,
    /shown/i,
    'the id-contract sentence must tie the allowed ids to the state shown below, not to ids in general',
  );
  assert.match(
    system,
    /refus/i,
    'the id-contract sentence must say that naming any other id is refused',
  );
});

test('refuses an assessment that claims a rule produced it', async () => {
  const createModelInterpretResidualEvidence = requireExport(
    'createModelInterpretResidualEvidence',
  );
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const { port } = fakePort([
    {
      assessments: [
        {
          id: 'a-1',
          evidenceId: 'evidence-1',
          hypothesisId: 'h-1',
          effect: 'supports',
          strength: 'high',
          rationale: 'because',
          producedBy: 'rule',
        },
      ],
    },
  ]);
  const node = createModelInterpretResidualEvidence({ port, at });

  await assert.rejects(
    () => node(initialState()),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError);
      return true;
    },
    'provenance is stamped by this layer, never taken from the model',
  );
});

/**
 * code-reviewer blocker 2 (round 1, `investigation-roles.ts:669`):
 * `createModelInterpretResidualEvidence` parsed an assessment only with
 * `EvidenceAssessmentSchema` and never checked `evidenceId` against
 * `state.evidence`, `hypothesisId` against `state.hypotheses`, or
 * `predictionId` against that hypothesis's own predictions. A fabricated id
 * from a model-quality failure here was not refused until
 * `propose_conclusion` later called `deriveHypothesisStatus`
 * (`packages/domain/src/evaluation.ts:152-166`), which throws a PLAIN `Error`
 * with no `role` field — a model-quality fault surfacing at the terminal node
 * as an untyped harness fault, exactly the misattribution
 * `model-errors.ts`/`ModelRoleOutputError` exist to prevent.
 *
 * These three rows pin the new contract: `interpret_residual_evidence`
 * refuses each case itself, as a `ModelRoleOutputError('interpret_residual_evidence', …)`,
 * before it ever reaches a later role.
 */
test('refuses an assessment whose evidenceId is not in state.evidence', async () => {
  const createModelInterpretResidualEvidence = requireExport(
    'createModelInterpretResidualEvidence',
  );
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const { port } = fakePort([
    {
      assessments: [
        {
          id: 'a-1',
          evidenceId: 'e-fabricated',
          hypothesisId: 'h-1',
          effect: 'supports',
          strength: 'high',
          rationale: 'because',
        },
      ],
    },
  ]);
  const node = createModelInterpretResidualEvidence({ port, at });
  const state = initialState();
  state.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
  ];

  await assert.rejects(
    () => node(state),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError, `expected a ModelRoleOutputError, got ${error}`);
      assert.equal(error.role, 'interpret_residual_evidence');
      assert.match(error.message, /e-fabricated/);
      return true;
    },
    'an assessment naming evidence the state does not carry must be refused here, not surface later as a plain Error out of deriveHypothesisStatus',
  );
});

test('refuses an assessment whose hypothesisId is not in state.hypotheses', async () => {
  const createModelInterpretResidualEvidence = requireExport(
    'createModelInterpretResidualEvidence',
  );
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const { port } = fakePort([
    {
      assessments: [
        {
          id: 'a-1',
          evidenceId: 'evidence-1',
          hypothesisId: 'h-fabricated',
          effect: 'supports',
          strength: 'high',
          rationale: 'because',
        },
      ],
    },
  ]);
  const node = createModelInterpretResidualEvidence({ port, at });
  const state = initialState();
  // state.hypotheses stays [] (initialState default): 'h-fabricated' names no
  // hypothesis the run carries.

  await assert.rejects(
    () => node(state),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError, `expected a ModelRoleOutputError, got ${error}`);
      assert.equal(error.role, 'interpret_residual_evidence');
      assert.match(error.message, /h-fabricated/);
      return true;
    },
    'an assessment naming a hypothesis the run does not carry must be refused here',
  );
});

test('refuses an assessment whose predictionId is not a prediction of the named hypothesis', async () => {
  const createModelInterpretResidualEvidence = requireExport(
    'createModelInterpretResidualEvidence',
  );
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const { port } = fakePort([
    {
      assessments: [
        {
          id: 'a-1',
          evidenceId: 'evidence-1',
          hypothesisId: 'h-1',
          predictionId: 'p-belongs-to-h-2',
          effect: 'supports',
          strength: 'high',
          rationale: 'because',
        },
      ],
    },
  ]);
  const node = createModelInterpretResidualEvidence({ port, at });
  const state = initialState();
  state.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
    { id: 'h-2', statement: 'the dependency upgrade, not the deploy', createdBy: 'initial' },
  ];
  state.predictions = [
    {
      id: 'p-belongs-to-h-2',
      hypothesisId: 'h-2',
      statement: 'if true, the pool exhausts under load',
      expectedIfTrue: [],
      expectedIfFalse: [],
      status: 'untested',
    },
  ];

  await assert.rejects(
    () => node(state),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError, `expected a ModelRoleOutputError, got ${error}`);
      assert.equal(error.role, 'interpret_residual_evidence');
      assert.match(error.message, /p-belongs-to-h-2/);
      return true;
    },
    "an assessment whose predictionId belongs to a DIFFERENT hypothesis must be refused: it is not 'a prediction of that hypothesis'",
  );
});

/**
 * AIC-124 slice b, item 5: the reducer for `assessments`
 * (`InvestigationStateAnnotation` in `@aic/graph`) is `upsertById`, which
 * REPLACES the record at a matching id rather than merging into it. A model
 * answer that reuses an id a rule assessment already holds would silently
 * overwrite a rule-produced verdict with a model one — exactly the confound
 * `producedBy` exists to keep apart. This role is the point where the model's
 * answer and `state.assessments` are both in hand, so the refusal belongs
 * here rather than at the reducer, which cannot tell a legitimate re-write of
 * the role's own prior answer from a hijack of a rule's.
 */
test('refuses an assessment whose id is already present in state.assessments, held by a rule assessment, naming the id escaped', async () => {
  const createModelInterpretResidualEvidence = requireExport(
    'createModelInterpretResidualEvidence',
  );
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const hostileId = `rule-"quoted"\nline-two-${'x'.repeat(500)}`;
  const { port } = fakePort([
    {
      assessments: [
        {
          id: hostileId,
          evidenceId: 'evidence-1',
          hypothesisId: 'h-1',
          effect: 'supports',
          strength: 'high',
          rationale: 'a model answer reusing the rule assessment id',
        },
      ],
    },
  ]);
  const node = createModelInterpretResidualEvidence({ port, at });
  const state = initialState();
  state.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
  ];
  state.assessments = [
    {
      id: hostileId,
      evidenceId: 'evidence-1',
      hypothesisId: 'h-1',
      effect: 'supports',
      strength: 'medium',
      rationale: 'a rule already assessed this pair',
      producedBy: 'rule',
      at: '2026-01-01T00:00:00.000Z',
    },
  ];

  await assert.rejects(
    () => node(state),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError, `expected a ModelRoleOutputError, got ${error}`);
      assert.equal(error.role, 'interpret_residual_evidence');
      assert.ok(
        !error.message.includes('\n'),
        'a raw newline from a hostile id must never reach the refusal message',
      );
      const expectedEscaped = JSON.stringify(hostileId.slice(0, 80));
      assert.ok(
        error.message.includes(expectedEscaped),
        `the message must carry the id JSON-escaped and truncated to 80 chars: ${JSON.stringify(error.message)}`,
      );
      return true;
    },
    'an assessment id the run already carries — held by a rule assessment — must be refused rather than overwritten: the reducer is upsertById, which REPLACES at a matching id',
  );
});

/**
 * AIC-124 slice b, item 5 continued: the refusal above protects a RULE
 * verdict from being silently overwritten by a model answer that reuses its
 * id. It does not extend to a model reusing the id of ITS OWN earlier answer
 * — an assessment `state.assessments` already holds with `producedBy: 'llm'`.
 * The role's own system prompt asks the model for `"id":"<stable id>"`, so a
 * model that re-assesses the same evidence/hypothesis pair in a later
 * iteration and repeats that id is doing what it was told, and the
 * `assessments` reducer (`upsertById`) is meant to replace the row at that id
 * with the role's fresh reading of it.
 */
test('accepts an assessment whose id is already present in state.assessments, held by a prior llm assessment of this role', async () => {
  const createModelInterpretResidualEvidence = requireExport(
    'createModelInterpretResidualEvidence',
  );
  const { port } = fakePort([
    {
      assessments: [
        {
          id: 'a-1',
          evidenceId: 'evidence-1',
          hypothesisId: 'h-1',
          effect: 'contradicts',
          strength: 'medium',
          rationale: 'a later iteration revised its own earlier reading',
        },
      ],
    },
  ]);
  const promptVersion = 'reference-prompt-under-test';
  const node = createModelInterpretResidualEvidence({ port, promptVersion, at });
  const state = initialState();
  state.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
  ];
  state.assessments = [
    {
      id: 'a-1',
      evidenceId: 'evidence-1',
      hypothesisId: 'h-1',
      effect: 'supports',
      strength: 'high',
      rationale: 'an earlier iteration of this same role',
      producedBy: 'llm',
      promptVersion: 'reference-prompt-under-test',
      at: '2026-01-01T00:00:00.000Z',
    },
  ];

  const update = await node(state);

  assert.deepEqual(update.assessments, [
    {
      id: 'a-1',
      evidenceId: 'evidence-1',
      hypothesisId: 'h-1',
      effect: 'contradicts',
      strength: 'medium',
      rationale: 'a later iteration revised its own earlier reading',
      producedBy: 'llm',
      promptVersion,
      at: at(),
    },
  ]);
  EvidenceAssessmentSchema.parse(update.assessments[0]);
  assert.equal(update.declaredLlmCalls, 1);
});

/**
 * `.claude/rules/invariants.md` ("State the limits — and test them"): any
 * model-supplied id reaching a refusal message must be escaped and truncated,
 * the same way `refuseUnknownKeys` and `conclusion-rules.ts`'s `quoteModelText`
 * already do for their own sinks. Uses a hostile hypothesisId; the other two
 * ids above are pinned by name-matching only, this row pins the escaping
 * mechanism itself.
 */
test('escapes and truncates a hostile hypothesisId before it reaches the refusal message', async () => {
  const createModelInterpretResidualEvidence = requireExport(
    'createModelInterpretResidualEvidence',
  );
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const hostileId = `"quoted"\nline-two-${'x'.repeat(500)}`;
  assert.ok(hostileId.length > 500, 'the fixture id must exceed 500 characters');
  const { port } = fakePort([
    {
      assessments: [
        {
          id: 'a-1',
          evidenceId: 'evidence-1',
          hypothesisId: hostileId,
          effect: 'supports',
          strength: 'high',
          rationale: 'because',
        },
      ],
    },
  ]);
  const node = createModelInterpretResidualEvidence({ port, at });
  const state = initialState();
  // state.hypotheses stays [], so the hostile id is refused as unrecognised.

  await assert.rejects(
    () => node(state),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError, `expected a ModelRoleOutputError, got ${error}`);
      assert.equal(error.role, 'interpret_residual_evidence');
      assert.ok(
        !error.message.includes('\n'),
        'a raw newline from a hostile id must never reach the refusal message',
      );
      // The first 80 characters of the fixture hold exactly 62 x's, so a run
      // of 63 or more can only come from the part truncation must drop.
      assert.doesNotMatch(
        error.message,
        /x{63,}/,
        'the id must be truncated to 80 characters: nothing past them may reach the message',
      );
      const expectedEscaped = JSON.stringify(hostileId.slice(0, 80));
      assert.ok(
        error.message.includes(expectedEscaped),
        `the message must carry the id JSON-escaped and truncated to 80 chars: ${JSON.stringify(error.message)}`,
      );
      return true;
    },
  );
});

/* -------------------------------------------------------------------------- */
/* challenge_hypothesis                                                       */
/* -------------------------------------------------------------------------- */

test('produces a valid challenge result with an alternative created by the challenge', async () => {
  const createModelChallengeHypothesis = requireExport('createModelChallengeHypothesis');
  const { port, requests } = fakePort([
    {
      alternative: {
        id: 'alt-1',
        statement: 'the dependency, not the deploy',
        cause: { component: 'dependency-pool', mechanism: 'capacity-exhaustion' },
      },
      discriminatingTests: [
        {
          id: 'dt-1',
          predictionId: 'p-1',
          tool: 'logs.search',
          input: { query: 'pool' },
          cost: 'cheap',
        },
      ],
    },
  ]);
  const challenge = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS, requestVocabulary: REQUEST_VOCABULARY });
  const state = initialState();
  state.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
  ];

  const result = await challenge(state, 'h-1');

  assert.deepEqual(result, {
    alternative: {
      id: 'alt-1',
      statement: 'the dependency, not the deploy',
      createdBy: 'challenge',
      cause: { component: 'dependency-pool', mechanism: 'capacity-exhaustion' },
    },
    discriminatingTests: [
      {
        id: 'dt-1',
        predictionId: 'p-1',
        tool: 'logs.search',
        input: { query: 'pool' },
        cost: 'cheap',
        status: 'planned',
      },
    ],
  });
  HypothesisSchema.parse(result.alternative);
  InvestigationTestSchema.parse(result.discriminatingTests[0]);
  assert.equal(
    'declaredLlmCalls' in result,
    false,
    'a ChallengeResult has no declaration channel; inventing one would be refused by the graph',
  );
  assert.match(requests[0].prompt, /the checkout deploy did it/);
});

test('refuses a challenge whose alternative repeats the hypothesis it was asked to challenge', async () => {
  const createModelChallengeHypothesis = requireExport('createModelChallengeHypothesis');
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const { port } = fakePort([
    {
      alternative: {
        id: 'h-1',
        statement: 'the checkout deploy did it',
        cause: { component: 'checkout-service', mechanism: 'config-drift' },
      },
      discriminatingTests: [
        { id: 'dt-1', predictionId: 'p-1', tool: 'logs.search', input: {}, cost: 'cheap' },
      ],
    },
  ]);
  const challenge = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS, requestVocabulary: REQUEST_VOCABULARY });
  const state = initialState();
  state.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
  ];

  await assert.rejects(() => challenge(state, 'h-1'), ModelRoleOutputError);
});

test('refuses a challenge carrying no discriminating test in the role, where a model-quality failure belongs', async () => {
  // A challenge with an empty `discriminatingTests` is a model-quality failure:
  // the provider answered, the transport worked, and the content is unusable.
  // The role used to pass it through, and `parseChallengeResult` in
  // `packages/graph` then refused it with `invalid challenge result` — a bare
  // `Error` from the harness. That routes a model failure through a harness
  // error and erases the one distinction `packages/roles/src/model-errors.ts`
  // says these types exist to keep, which is also the distinction the live-model
  // lane reports on.
  const createModelChallengeHypothesis = requireExport('createModelChallengeHypothesis');
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const { port } = fakePort([
    {
      alternative: {
        id: 'alt-1',
        statement: 'the dependency, not the deploy',
        cause: { component: 'dependency-pool', mechanism: 'capacity-exhaustion' },
      },
      discriminatingTests: [],
    },
  ]);
  const challenge = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS, requestVocabulary: REQUEST_VOCABULARY });
  const state = initialState();
  state.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
  ];

  await assert.rejects(
    () => challenge(state, 'h-1'),
    (error) => {
      assert.ok(
        error instanceof ModelRoleOutputError,
        'a challenge that discriminates nothing is output the domain refuses, not a transport or harness fault',
      );
      assert.equal(error.role, 'challenge_hypothesis', 'the refusal names the role that produced it');
      assert.doesNotMatch(
        error.message,
        /invalid challenge result/,
        "the graph's generic message means the role handed the empty array on and the harness caught it instead",
      );
      return true;
    },
  );
});

/* -------------------------------------------------------------------------- */
/* D2b: a discriminating test input canonicalJson cannot serialise (AIC-135)  */
/* -------------------------------------------------------------------------- */

/**
 * AIC-135: `discriminatingTests[].input` is `InvestigationTestSchema`'s
 * `z.unknown()`, and the PROVIDER's own closed schema (`challengeSchema`,
 * above) is enforced by the provider only — a fake port answering raw text,
 * exactly like "refuses an answer that carries no JSON document at all" above,
 * bypasses it the same way a provider that ignores `output_config.format`
 * would. Measured directly against this role with such a port, without this
 * guard: an unrefused `Infinity` or a deeply nested `input` passed straight
 * through, and `planInvestigation`'s `canonicalJson`
 * (`packages/domain/src/execution.ts`) is what threw instead, inside the
 * challenge round: a `TypeError` on a non-finite number, and a `RangeError`
 * (stack overflow — measured directly: `canonicalJson` enforces no explicit
 * depth limit, and a plain recursive walk over a 20000-level input threw
 * consistently) on nesting. Both are
 * JSON-reachable: a model can emit the literal `1e999`, which `JSON.parse`
 * reads as `Infinity`, and nothing bounds how deep a JSON document nests.
 * see investigation-planning.test.mjs › "planInvestigation throws when an
 * existing test's input cannot be canonicalised (a BigInt value)" and ›
 * "planInvestigation throws when an existing test's input cannot be
 * canonicalised (a circular reference)" for the planner's own stated limit,
 * left untouched: these rows ask the role to refuse a shape as a
 * MODEL-QUALITY failure before it ever reaches the planner, not to change
 * what the planner itself does.
 */
test('refuses a discriminating test whose input carries a value canonicalJson cannot serialise (a non-finite number from the JSON literal 1e999)', async () => {
  const createModelChallengeHypothesis = requireExport('createModelChallengeHypothesis');
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  // Built as raw text, not a JS object passed through JSON.stringify: JSON.stringify(Infinity)
  // is "null", which would silently lose the exact shape this row exists to pin.
  const rawText =
    '{"alternative":{"id":"alt-1","statement":"the dependency, not the deploy","cause":{"component":"dependency-pool","mechanism":"capacity-exhaustion"}},' +
    '"discriminatingTests":[{"id":"dt-infinity","predictionId":"p-1","tool":"logs.search","input":{"service":1e999},"cost":"cheap"}]}';
  const { port } = fakePort([rawText]);
  const challenge = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS, requestVocabulary: REQUEST_VOCABULARY });
  const state = initialState();
  state.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
  ];

  await assert.rejects(
    () => challenge(state, 'h-1'),
    (error) => {
      assert.ok(
        error instanceof ModelRoleOutputError,
        'a discriminating test input the planner cannot serialise is a model-quality refusal, not a crash inside a later round',
      );
      assert.equal(error.role, 'challenge_hypothesis');
      assert.match(
        error.message,
        /dt-infinity/,
        'the refusal must name the discriminating test it refused',
      );
      return true;
    },
  );
});

test('refuses a discriminating test whose input nests deeper than canonicalJson can walk (20000 levels)', async () => {
  const createModelChallengeHypothesis = requireExport('createModelChallengeHypothesis');
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  // Measured directly against canonicalJson (packages/domain/src/execution.ts):
  // its plain recursive walk, with no explicit depth cap, throws "RangeError:
  // Maximum call stack size exceeded" at this depth — observed failing
  // consistently at 20000 levels.
  const nestedArrayText = '['.repeat(20000) + '1' + ']'.repeat(20000);
  const rawText =
    '{"alternative":{"id":"alt-1","statement":"the dependency, not the deploy","cause":{"component":"dependency-pool","mechanism":"capacity-exhaustion"}},' +
    '"discriminatingTests":[{"id":"dt-deep","predictionId":"p-1","tool":"logs.search","input":{"service":"x","nested":' +
    nestedArrayText +
    '},"cost":"cheap"}]}';
  const { port } = fakePort([rawText]);
  const challenge = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS, requestVocabulary: REQUEST_VOCABULARY });
  const state = initialState();
  state.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
  ];

  await assert.rejects(
    () => challenge(state, 'h-1'),
    (error) => {
      assert.ok(
        error instanceof ModelRoleOutputError,
        'a discriminating test input nested deeper than the planner can canonicalise is a model-quality refusal, not a stack overflow inside a later round',
      );
      assert.equal(error.role, 'challenge_hypothesis');
      assert.match(
        error.message,
        /dt-deep/,
        'the refusal must name the discriminating test it refused',
      );
      return true;
    },
  );
});

test('does not refuse a discriminating test whose input is an ordinary closed-shape value', async () => {
  const createModelChallengeHypothesis = requireExport('createModelChallengeHypothesis');
  const { port } = fakePort([
    {
      alternative: {
        id: 'alt-1',
        statement: 'the dependency, not the deploy',
        cause: { component: 'dependency-pool', mechanism: 'capacity-exhaustion' },
      },
      discriminatingTests: [
        {
          id: 'dt-ordinary',
          predictionId: 'p-1',
          tool: 'metrics',
          input: { service: 'orders-db', window: 'incident' },
          cost: 'cheap',
        },
      ],
    },
  ]);
  const challenge = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS, requestVocabulary: REQUEST_VOCABULARY });
  const state = initialState();
  state.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
  ];

  const result = await challenge(state, 'h-1');

  assert.deepEqual(result.discriminatingTests[0].input, { service: 'orders-db', window: 'incident' });
});

/**
 * The round-1 gate on AIC-135 (code-reviewer and security-scanner, both HOLD)
 * measured that `investigation-roles.ts:838`'s refusal restates
 * `JSON.stringify(test.id)` by hand instead of `quoteModelText`
 * (`packages/domain/src/conclusion-rules.ts`), so a hostile id is escaped but
 * not truncated. This is the sibling of `roles-model-nodes.test.mjs` ›
 * "escapes and truncates a hostile hypothesisId before it reaches the refusal
 * message", for the discriminating test's own id.
 */
test('escapes and truncates a hostile discriminating-test id before it reaches the refusal message', async () => {
  const createModelChallengeHypothesis = requireExport('createModelChallengeHypothesis');
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const hostileId = `"quoted"\nline-two-${'x'.repeat(780)}`;
  assert.ok(hostileId.length > 700, 'the fixture id must exceed 700 characters');
  // Built as raw text, not a JS object passed through JSON.stringify:
  // JSON.stringify(Infinity) is "null", which would silently lose the
  // non-finite input this row relies on to reach the refusal at all.
  const rawText =
    '{"alternative":{"id":"alt-1","statement":"the dependency, not the deploy","cause":{"component":"dependency-pool","mechanism":"capacity-exhaustion"}},' +
    '"discriminatingTests":[{"id":' +
    JSON.stringify(hostileId) +
    ',"predictionId":"p-1","tool":"logs.search","input":{"service":1e999},"cost":"cheap"}]}';
  const { port } = fakePort([rawText]);
  const challenge = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS, requestVocabulary: REQUEST_VOCABULARY });
  const state = initialState();
  state.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
  ];

  await assert.rejects(
    () => challenge(state, 'h-1'),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError, `expected a ModelRoleOutputError, got ${error}`);
      assert.equal(error.role, 'challenge_hypothesis');
      assert.ok(
        !error.message.includes('\n'),
        'a raw newline from a hostile discriminating-test id must never reach the refusal message',
      );
      // The first 80 characters of the fixture hold exactly 62 x's, so a run
      // of 63 or more can only come from the part truncation must drop.
      assert.doesNotMatch(
        error.message,
        /x{63,}/,
        'the id must be truncated to 80 characters before it reaches the message',
      );
      const expectedEscaped = JSON.stringify(hostileId.slice(0, 80));
      assert.ok(
        error.message.includes(expectedEscaped),
        `the message must carry the id JSON-escaped and truncated to 80 chars, per quoteModelText's contract: ${JSON.stringify(error.message)}`,
      );
      return true;
    },
  );
});

/**
 * The round-1 gate also measured that the depth bound and the node budget
 * mask each other: removing either check left every existing row green,
 * because the OTHER bound caught the removed one's own fixture. These four
 * rows trip one bound at a time, with the other bound's own wording asserted
 * absent, so a future regression that silences one bound cannot hide behind
 * the other's message. The wording pinned here is the guard's OWN bound
 * (`CANONICALISABLE_INPUT_MAX_DEPTH` / `CANONICALISABLE_INPUT_MAX_NODES` in
 * `investigation-roles.ts`), not the planner's.
 */
function nestedArrayOfDepth(levels) {
  let value = 1;
  for (let i = 0; i < levels; i += 1) value = [value];
  return value;
}

test('refuses a discriminating test whose input nests exactly 33 levels deep, one past the guard\'s own depth bound', async () => {
  const createModelChallengeHypothesis = requireExport('createModelChallengeHypothesis');
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const { port } = fakePort([
    {
      alternative: {
        id: 'alt-1',
        statement: 'the dependency, not the deploy',
        cause: { component: 'dependency-pool', mechanism: 'capacity-exhaustion' },
      },
      discriminatingTests: [
        {
          id: 'dt-depth-33',
          predictionId: 'p-1',
          tool: 'logs.search',
          input: nestedArrayOfDepth(33),
          cost: 'cheap',
        },
      ],
    },
  ]);
  const challenge = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS, requestVocabulary: REQUEST_VOCABULARY });
  const state = initialState();
  state.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
  ];

  await assert.rejects(
    () => challenge(state, 'h-1'),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError, `expected a ModelRoleOutputError, got ${error}`);
      assert.equal(error.role, 'challenge_hypothesis');
      assert.match(
        error.message,
        /nests deeper than 32 levels/,
        "the depth refusal must name the guard's own bound, not the planner's",
      );
      assert.doesNotMatch(
        error.message,
        /has more than 5000 values/,
        'a depth-only violation must not also read as the node-budget wording, or the two bounds are masking each other',
      );
      return true;
    },
  );
});

test('does not refuse a discriminating test whose input nests exactly 32 levels deep, the most the guard accepts', async () => {
  const createModelChallengeHypothesis = requireExport('createModelChallengeHypothesis');
  const input = nestedArrayOfDepth(32);
  const { port } = fakePort([
    {
      alternative: {
        id: 'alt-1',
        statement: 'the dependency, not the deploy',
        cause: { component: 'dependency-pool', mechanism: 'capacity-exhaustion' },
      },
      discriminatingTests: [
        { id: 'dt-depth-32', predictionId: 'p-1', tool: 'logs.search', input, cost: 'cheap' },
      ],
    },
  ]);
  const challenge = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS, requestVocabulary: REQUEST_VOCABULARY });
  const state = initialState();
  state.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
  ];

  const result = await challenge(state, 'h-1');

  assert.deepEqual(result.discriminatingTests[0].input, input);
});

// Node budget arithmetic (CANONICALISABLE_INPUT_MAX_NODES = 5000): the walk
// visits the top-level object itself (1 node) + the array it owns (1 node) +
// every element of that array (one node each) = elementCount + 2 nodes total,
// at depth 2 for the elements — well inside the depth bound either way, so
// only the node budget can fire.
function shallowWideInput(elementCount) {
  return { key: Array.from({ length: elementCount }, () => 'a') };
}

test('refuses a discriminating test whose input carries more than 5000 values, one key holding a 5001-element array', async () => {
  const createModelChallengeHypothesis = requireExport('createModelChallengeHypothesis');
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const { port } = fakePort([
    {
      alternative: {
        id: 'alt-1',
        statement: 'the dependency, not the deploy',
        cause: { component: 'dependency-pool', mechanism: 'capacity-exhaustion' },
      },
      discriminatingTests: [
        {
          id: 'dt-wide-5001',
          predictionId: 'p-1',
          tool: 'logs.search',
          input: shallowWideInput(5001),
          cost: 'cheap',
        },
      ],
    },
  ]);
  const challenge = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS, requestVocabulary: REQUEST_VOCABULARY });
  const state = initialState();
  state.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
  ];

  await assert.rejects(
    () => challenge(state, 'h-1'),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError, `expected a ModelRoleOutputError, got ${error}`);
      assert.equal(error.role, 'challenge_hypothesis');
      assert.match(
        error.message,
        /has more than 5000 values/,
        "the node-budget refusal must name the guard's own bound, not the planner's",
      );
      assert.doesNotMatch(
        error.message,
        /nests deeper than 32 levels/,
        'a node-budget-only violation must not also read as the depth wording, or the two bounds are masking each other',
      );
      return true;
    },
  );
});

test('does not refuse a discriminating test whose input stays within the node budget, one key holding a 4998-element array (5000 nodes visited in total)', async () => {
  const createModelChallengeHypothesis = requireExport('createModelChallengeHypothesis');
  const input = shallowWideInput(4998);
  const { port } = fakePort([
    {
      alternative: {
        id: 'alt-1',
        statement: 'the dependency, not the deploy',
        cause: { component: 'dependency-pool', mechanism: 'capacity-exhaustion' },
      },
      discriminatingTests: [
        { id: 'dt-wide-4998', predictionId: 'p-1', tool: 'logs.search', input, cost: 'cheap' },
      ],
    },
  ]);
  const challenge = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS, requestVocabulary: REQUEST_VOCABULARY });
  const state = initialState();
  state.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
  ];

  const result = await challenge(state, 'h-1');

  assert.deepEqual(result.discriminatingTests[0].input, input);
});

/**
 * Security-scanner's round-1 advisory: `input` is undefined when the key is
 * entirely absent, `canonicalJson(undefined)` throws, and the provider schema
 * requires `input` so no compliant answer is affected — but the three
 * original AIC-135 rows never covered it. Pinned here so the gap is closed
 * rather than merely noted.
 */
test('refuses a discriminating test that carries no input key at all', async () => {
  const createModelChallengeHypothesis = requireExport('createModelChallengeHypothesis');
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const { port } = fakePort([
    {
      alternative: {
        id: 'alt-1',
        statement: 'the dependency, not the deploy',
        cause: { component: 'dependency-pool', mechanism: 'capacity-exhaustion' },
      },
      discriminatingTests: [
        { id: 'dt-no-input', predictionId: 'p-1', tool: 'logs.search', cost: 'cheap' },
      ],
    },
  ]);
  const challenge = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS, requestVocabulary: REQUEST_VOCABULARY });
  const state = initialState();
  state.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
  ];

  await assert.rejects(
    () => challenge(state, 'h-1'),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError, `expected a ModelRoleOutputError, got ${error}`);
      assert.equal(error.role, 'challenge_hypothesis');
      assert.match(
        error.message,
        /dt-no-input/,
        'the refusal must name the discriminating test it refused',
      );
      return true;
    },
  );
});

/* -------------------------------------------------------------------------- */
/* D3: the asymmetry between the two channels, pinned                         */
/* -------------------------------------------------------------------------- */

test('folds the two wrapped roles into llmCallsUsed through the graph', async () => {
  const createModelGenerateHypotheses = requireExport('createModelGenerateHypotheses');
  const createModelInterpretResidualEvidence = requireExport(
    'createModelInterpretResidualEvidence',
  );
  const { port } = fakePort([
    {
      hypotheses: [
        {
          id: 'h-1',
          statement: 'a cause',
          cause: { component: 'checkout-service', mechanism: 'config-drift' },
        },
      ],
    },
    { assessments: [] },
  ]);

  const nodes = Object.fromEntries(
    lifecycleNodes.map((name) => [name, async () => ({})]),
  );
  nodes.generate_hypotheses = createModelGenerateHypotheses({ port, at, mechanisms: MECHANISMS });
  nodes.interpret_residual_evidence = createModelInterpretResidualEvidence({ port, at });
  nodes.termination_check = async () => ({ route: 'terminal', stopKind: 'stalled' });
  nodes.challenge_hypothesis = async () => ({});

  const graph = createInvestigationGraph({ nodes });
  const result = await graph.execute({ kind: 'start', state: initialState() });

  assert.equal(
    result.control.llmCallsUsed,
    2,
    'each wrapped model role declares exactly one call per execution',
  );
});

test('records the challenge role usage in the ledger while the graph counter cannot see it', async () => {
  const createModelChallengeHypothesis = requireExport('createModelChallengeHypothesis');
  const createReferenceModelPort = requireExport('createReferenceModelPort');
  const createModelUsageLedger = requireExport('createModelUsageLedger');
  const ledger = createModelUsageLedger({ maxCalls: 4 });
  const apiKey = ['sk', 'ant', 'test', '0'.repeat(24)].join('-');

  const port = createReferenceModelPort({
    apiKey,
    modelId: 'claude-under-test',
    ledger,
    async fetchImpl() {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  alternative: {
                    id: 'alt-1',
                    statement: 'another cause entirely',
                    cause: { component: 'dependency-pool', mechanism: 'capacity-exhaustion' },
                  },
                  discriminatingTests: [
                    {
                      id: 'dt-1',
                      predictionId: 'p-1',
                      tool: 'logs.search',
                      input: {},
                      cost: 'cheap',
                    },
                  ],
                }),
              },
            ],
            usage: { input_tokens: 21, output_tokens: 9 },
          };
        },
        async text() {
          return '';
        },
      };
    },
  });

  const challenge = createModelChallengeHypothesis({ port, at, mechanisms: MECHANISMS, requestVocabulary: REQUEST_VOCABULARY });
  const state = initialState();
  state.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
  ];

  const result = await challenge(state, 'h-1');

  assert.equal(result.alternative.createdBy, 'challenge');
  assert.deepEqual(
    ledger.read(),
    { calls: 1, inputTokens: 21, outputTokens: 9 },
    'the ledger is the only place a challenge round reports what it spent',
  );
  assert.equal(
    'declaredLlmCalls' in result,
    false,
    'the asymmetry is the point: ChallengeResult carries no declaration field',
  );
});

test('declares the asymmetry between the two consumption channels in the ledger module', () => {
  const source = new URL(
    '../packages/roles/src/model-usage-ledger.ts',
    import.meta.url,
  );
  const text = readFileSync(source, 'utf8');

  assert.match(
    text,
    /challenge_hypothesis/,
    'the limit must be stated where the channel is implemented',
  );
  assert.match(text, /declaredLlmCalls/);
});

/**
 * 🔴 **The hole that let a broken lane reach a one-shot hold-out run.**
 *
 * The row above is the ONLY place this file drives the graph, and its
 * `termination_check` returns no `leaderId`, so `routeChallenge` is never
 * entered. `live-model-lane.test.mjs` compares the two arms as OBJECTS, with a
 * port that throws if called. Between them, `modelNodes` was asserted about
 * everywhere and EXECUTED through `createInvestigationGraph` nowhere.
 *
 * What that hid: the replay fixture hard-codes `leader-${runId}` in
 * `generate_hypotheses` and names the same constant from `termination_check`.
 * The model arm swaps the first and keeps the second, so the scripted
 * terminator named a hypothesis the model never minted and the graph refused it
 * — correctly, at `investigation.ts:1387`. The suite stayed green at 893/893
 * while `npm run eval:live-model` could not complete a single model-arm record.
 *
 * This row closes the hole rather than the symptom: it drives a model-backed
 * `generate_hypotheses` all the way to a challenge, which is the path no test
 * took.
 */
test('routes a model-backed run to its challenge, with the leader the graph can see', async () => {
  const createModelGenerateHypotheses = requireExport('createModelGenerateHypotheses');
  const { port } = fakePort([
    {
      hypotheses: [
        {
          id: 'h-model-1',
          statement: 'a cause the model named',
          cause: { component: 'checkout-service', mechanism: 'config-drift' },
        },
      ],
    },
  ]);

  const nodes = Object.fromEntries(
    lifecycleNodes.map((name) => [name, async () => ({})]),
  );
  nodes.generate_hypotheses = createModelGenerateHypotheses({ port, at, mechanisms: MECHANISMS });
  // The shape the replay fixture uses: a terminal decision that names a leader.
  // Derived from the state rather than from a constant, which is the whole
  // difference between a harness that survives a role swap and one that does not.
  nodes.termination_check = async (state) => ({
    route: 'terminal',
    stopKind: 'sufficient',
    leaderId: state.hypotheses[0]?.id,
  });
  let challengedWith;
  nodes.challenge_hypothesis = async (_state, leaderId) => {
    challengedWith = leaderId;
    return {
      alternative: {
        id: 'alt-1',
        statement: 'an alternative the challenge proposed',
        createdBy: 'challenge',
      },
      discriminatingTests: [{
        id: 'challenge-test-1',
        predictionId: 'challenge-prediction-1',
        tool: 'logs.search',
        input: { probe: true },
        cost: 'cheap',
        status: 'planned',
      }],
    };
  };

  const graph = createInvestigationGraph({ nodes });
  const result = await graph.execute({ kind: 'start', state: initialState() });

  assert.equal(
    challengedWith,
    'h-model-1',
    'the challenge must target a hypothesis the model actually minted: a terminator naming an id from another producer is the defect this row exists for',
  );
  assert.ok(
    result.hypotheses.some(({ id }) => id === 'h-model-1'),
    'the model-proposed hypothesis must be in the state the challenge ran against',
  );
});

/**
 * 🔴 **A truncated answer is the harness cutting the model off, not the model
 * answering badly — and the role used to report the second.**
 *
 * The port did not read `stop_reason`, so a completion the provider stopped at
 * `max_tokens` arrived as an ordinary string, `JSON.parse` failed on the
 * half-written object, and the role said "the answer is not parseable JSON".
 * That is a false statement about the one thing this lane measures.
 *
 * Measured on a real calibration run before the guard existed:
 * a lane report recording the model as producing malformed output, and the
 * lane recorded the model arm unreportable for producing malformed output.
 *
 * This repository already refuses the two neighbours of this mistake — a
 * missing measurement never becomes a zero, and a model run that did not happen
 * is never model-quality evidence. A run that was CUT OFF being reported as a
 * model failure is the same error wearing a third face.
 */
test('refuses a truncated answer as a truncation rather than as malformed output', async () => {
  const createModelInterpretResidualEvidence = requireExport(
    'createModelInterpretResidualEvidence',
  );

  const truncating = {
    async complete() {
      return {
        text: '{"assessments":[{"id":"a-1",',
        modelId: 'claude-under-test',
        usage: { inputTokens: 10, outputTokens: 4096 },
        stopReason: 'max_tokens',
      };
    },
  };

  await assert.rejects(
    () => createModelInterpretResidualEvidence({ port: truncating, at })(initialState()),
    (error) => {
      assert.match(
        error.message,
        /truncat|max_tokens|token budget/i,
        `the refusal must name the truncation: ${error.message}`,
      );
      assert.doesNotMatch(
        error.message,
        /not parseable JSON/,
        `a cut-off answer is not the model writing bad JSON, and reporting it as such attributes a harness limit to model quality: ${error.message}`,
      );
      return true;
    },
    'a completion the provider stopped at the token budget must be reported as that',
  );
});

test('reads an unknown stop reason as not a truncation, so a malformed answer is still the model', () => {
  // The other direction of the same false attribution: excusing genuinely bad
  // output as a harness limit. The truncation set is deliberately narrow.
  const createModelInterpretResidualEvidence = requireExport(
    'createModelInterpretResidualEvidence',
  );
  const oddStop = {
    async complete() {
      return {
        text: 'not json at all',
        modelId: 'claude-under-test',
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'some_reason_this_code_does_not_know',
      };
    },
  };

  return assert.rejects(
    () => createModelInterpretResidualEvidence({ port: oddStop, at })(initialState()),
    /carries no JSON document|not parseable JSON/,
    'an unknown stop reason must not excuse a malformed answer: guessing that way would attribute a model failure to the harness, which is this defect in reverse',
  );
});

/**
 * 🔴 **An optional field the prompt asks for, refused in its ordinary JSON
 * spelling — and the refusal landed on the model.**
 *
 * The role's own prompt declares `"predictionId":"<id, optional>"`. A model
 * answering `null` for an optional field is writing ordinary JSON, and the role
 * treated only `undefined` as absent, so the value reached
 * `EvidenceAssessmentSchema` and was refused: "expected string, received null".
 * The lane then recorded the model arm unreportable.
 *
 * Measured on a real calibration run. It is the same shape as the truncation
 * defect one row up: a harness contract the model was never told about, charged
 * to model quality. For an OPTIONAL field, `null` and absent are the same claim.
 *
 * ⚠ This does not widen the schema. A `null` in a REQUIRED field is still
 * refused, and the row below holds that line — otherwise this fix would trade a
 * false accusation for a silent acceptance.
 */
test('reads null as absent for an optional assessment field, as any JSON author would write it', async () => {
  const createModelInterpretResidualEvidence = requireExport(
    'createModelInterpretResidualEvidence',
  );
  const { port } = fakePort([
    {
      assessments: [{
        id: 'a-1',
        evidenceId: 'evidence-1',
        hypothesisId: 'h-1',
        predictionId: null,
        effect: 'supports',
        strength: 'high',
        rationale: 'the evidence bears on the hypothesis',
      }],
    },
  ]);

  // The assessment names evidence and a hypothesis the state really carries, so
  // the only thing under test is how an optional field spelled null is read.
  const state = {
    ...initialState(),
    hypotheses: [{ id: 'h-1', statement: 'a plausible cause', createdBy: 'initial' }],
  };
  const result = await createModelInterpretResidualEvidence({ port, at })(state);

  assert.equal(result.assessments.length, 1, 'the assessment must survive an optional field spelled null');
  assert.equal(
    Object.hasOwn(result.assessments[0], 'predictionId'),
    false,
    'an optional field the model declined must be ABSENT in the stamped assessment, not carried as null: absent is what "no prediction" means to everything downstream',
  );
});

test('still refuses null in a required assessment field', async () => {
  const createModelInterpretResidualEvidence = requireExport(
    'createModelInterpretResidualEvidence',
  );
  const { port } = fakePort([
    {
      assessments: [{
        id: 'a-1',
        evidenceId: null,
        hypothesisId: 'h-1',
        effect: 'supports',
        strength: 'high',
        rationale: 'the evidence bears on the hypothesis',
      }],
    },
  ]);

  await assert.rejects(
    () => createModelInterpretResidualEvidence({ port, at })(initialState()),
    /evidenceId/,
    'reading null as absent is correct for an OPTIONAL field and wrong for a required one: without this row the previous fix would trade a false accusation against the model for a silent acceptance of a broken assessment',
  );
});

/**
 * 🔴 **A hand-written enum in the answer schema is a second spelling of a
 * domain fact, and one of them went wrong within an hour.**
 *
 * The first version of the provider-enforced answer schemas restated the
 * domain's vocabularies. `cost` was written `['cheap','moderate','expensive']`
 * where the domain declares `['cheap','medium','expensive']`. The model then
 * answered exactly what the schema asked for, the domain refused it, and the
 * lane recorded the model arm unreportable — a harness defect charged to model
 * quality, on the one axis this gate exists to report honestly.
 *
 * `.claude/rules/invariants.md`: "If two files enforce the same invariant, they
 * will disagree — and the one nobody is looking at is the one that is wrong."
 *
 * This row reads the schema the roles actually send and compares each enum
 * against the domain, so a domain change cannot leave a stale copy behind.
 */
test('derives every answer-schema enum from the domain rather than restating it', async () => {
  const createModelChallengeHypothesis = requireExport('createModelChallengeHypothesis');
  const createModelInterpretResidualEvidence = requireExport(
    'createModelInterpretResidualEvidence',
  );
  const { InvestigationTestSchema, EvidenceAssessmentSchema } = await import('@aic/domain');

  const captured = [];
  const capturingPort = {
    async complete(request) {
      captured.push(request.outputSchema);
      throw new Error('stop here: this row reads the request, not the answer');
    },
  };

  for (const make of [createModelChallengeHypothesis, createModelInterpretResidualEvidence]) {
    try {
      const node = make({ port: capturingPort, at, mechanisms: MECHANISMS });
      await node(initialState(), 'h-1');
    } catch {
      // The port throws by design; the schema was captured first.
    }
  }

  const [challengeSchema, assessmentSchema] = captured;

  // 🔴 All THREE roles, not two. Deleting `outputSchema: HYPOTHESES_SCHEMA` left
  // the suite at 911/911: that wiring was demonstrated by nothing, while the
  // other two reddened only incidentally through the enum comparisons below.
  // A schema a role does not send is a constraint the provider never applies.
  const hypothesesNode = requireExport('createModelGenerateHypotheses')({
    port: capturingPort,
    at,
    mechanisms: MECHANISMS,
  });
  try {
    await hypothesesNode(initialState());
  } catch {
    // the port throws by design; the schema was captured first
  }
  const hypothesesSchema = captured[captured.length - 1];
  assert.equal(
    hypothesesSchema?.properties?.hypotheses?.items?.properties?.statement?.type,
    'string',
    'generate_hypotheses must send its schema too: a role that declares none asks the provider to enforce nothing, and the encoding failure this repair removes comes straight back for that role',
  );

  assert.deepEqual(
    challengeSchema.properties.discriminatingTests.items.properties.cost.enum,
    InvestigationTestSchema.shape.cost.options,
    'the cost vocabulary must come from the domain: a restated one was wrong on its first day, and the model answering the schema exactly is then recorded as the model failing',
  );
  assert.deepEqual(
    assessmentSchema.properties.assessments.items.properties.effect.enum,
    EvidenceAssessmentSchema.shape.effect.options,
    'the effect vocabulary must come from the domain',
  );
  assert.deepEqual(
    assessmentSchema.properties.assessments.items.properties.strength.enum,
    EvidenceAssessmentSchema.shape.strength.options,
    'the strength vocabulary must come from the domain',
  );
});

/**
 * 🔴 The token budget the roles hand the port, pinned — because the last time it
 * was wrong the record blamed the model.
 *
 * The hold-out at candidate `872ef36dea33` refused the model arm with
 * `stop_reason: max_tokens` at exactly 4096 output tokens, and the record read
 * as a model-quality failure. The budget was raised to clear it. That raise was
 * then MUTATION-PROVEN unpinned at the AIC-19 gate: setting the constant back to
 * 4096 left the whole suite green, so nothing in this repository would have
 * noticed the ceiling coming back.
 *
 * This row asserts the number the roles actually send, read off the request the
 * port received, rather than the constant — a test that imports the constant and
 * compares it to itself pins nothing.
 */
test('hands the provider a token budget large enough that the reference model was not cut off at 4096', async () => {
  const roles = [
    ['createModelGenerateHypotheses', { hypotheses: [{ id: 'h-1', statement: 's' }] }],
    [
      'createModelInterpretResidualEvidence',
      { assessments: [{ id: 'e-1', supports: [], contradicts: [], rationale: 'r' }] },
    ],
  ];

  // `challenge_hypothesis` is in this list deliberately: it is the role its own
  // rationale names as the one truncated at 4096, and the first draft of this
  // row omitted it. All three read the same constant today, so a per-role
  // override is exactly what a pin that skipped one would miss.
  roles.push([
    'createModelChallengeHypothesis',
    {
      alternative: {
        id: 'alt-1',
        statement: 'a different cause',
        cause: { component: 'dependency-pool', mechanism: 'capacity-exhaustion' },
      },
      discriminatingTests: [],
    },
  ]);

  for (const [name, answer] of roles) {
    const { port, requests } = fakePort([answer]);
    const node = requireExport(name)({ port, at, mechanisms: MECHANISMS });
    await node(initialState(), 'h-1').catch(() => {});

    assert.equal(requests.length, 1, `${name} must have reached the port exactly once`);
    const budget = requests[0].maxOutputTokens;
    assert.equal(
      typeof budget,
      'number',
      `${name} must declare a token budget: absent, the provider applies its own and the roles no longer decide it`,
    );
    assert.ok(
      budget > 4096,
      `${name} must ask for more than 4096 output tokens: measured on the hold-out at candidate 872ef36dea33, the reference model stopped at exactly that ceiling with stop_reason max_tokens and the record recorded it as the model answering badly (got ${budget})`,
    );
  }
});
