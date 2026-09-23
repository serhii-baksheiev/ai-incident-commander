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
import { createInvestigationGraph } from '@aic/graph';
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

/* -------------------------------------------------------------------------- */
/* generate_hypotheses                                                        */
/* -------------------------------------------------------------------------- */

test('produces hypotheses the domain schema accepts and declares the call it made', async () => {
  const createModelGenerateHypotheses = requireExport('createModelGenerateHypotheses');
  const { port, requests } = fakePort([
    {
      hypotheses: [
        { id: 'h-1', statement: 'the checkout deploy changed the db endpoint' },
        { id: 'h-2', statement: 'the dependency upgrade broke pooling' },
      ],
    },
  ]);
  const node = createModelGenerateHypotheses({ port, at });

  const update = await node(initialState());

  assert.deepEqual(update.hypotheses, [
    { id: 'h-1', statement: 'the checkout deploy changed the db endpoint', createdBy: 'initial' },
    { id: 'h-2', statement: 'the dependency upgrade broke pooling', createdBy: 'initial' },
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
    { hypotheses: [{ id: 'h-1', statement: 'a plausible cause' }] },
  ]);
  const node = createModelGenerateHypotheses({ port, at });

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
    { hypotheses: [{ id: 'h-existing', statement: 'hijacked' }] },
  ]);
  const node = createModelGenerateHypotheses({ port, at });

  await assert.rejects(
    () => node(state),
    (error) =>
      error instanceof ModelRoleOutputError &&
      /already carries: h-existing/.test(error.message),
    'the refusal must name the id it refused on',
  );
});

test('refuses two hypotheses the model gave the same id', async () => {
  const createModelGenerateHypotheses = requireExport('createModelGenerateHypotheses');
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const { port } = fakePort([
    {
      hypotheses: [
        { id: 'h-1', statement: 'the first' },
        { id: 'h-1', statement: 'the second, which would replace the first' },
      ],
    },
  ]);
  const node = createModelGenerateHypotheses({ port, at });

  await assert.rejects(() => node(initialState()), ModelRoleOutputError);
});

test('refuses a hypothesis set the domain schema does not accept', async () => {
  const createModelGenerateHypotheses = requireExport('createModelGenerateHypotheses');
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const { port } = fakePort([{ hypotheses: [{ id: 'h-1' }] }]);
  const node = createModelGenerateHypotheses({ port, at });

  await assert.rejects(() => node(initialState()), ModelRoleOutputError);
});

test('reads a JSON answer the model wrapped in prose or a fenced block', async () => {
  const createModelGenerateHypotheses = requireExport('createModelGenerateHypotheses');
  const { port } = fakePort([
    'Here is my answer:\n```json\n{"hypotheses":[{"id":"h-1","statement":"a cause"}]}\n```\nHope that helps.',
  ]);
  const node = createModelGenerateHypotheses({ port, at });

  const update = await node(initialState());

  assert.deepEqual(update.hypotheses, [
    { id: 'h-1', statement: 'a cause', createdBy: 'initial' },
  ]);
});

test('refuses an answer that carries no JSON document at all', async () => {
  const createModelGenerateHypotheses = requireExport('createModelGenerateHypotheses');
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');
  const { port } = fakePort(['I would rather not answer that.']);
  const node = createModelGenerateHypotheses({ port, at });

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

/* -------------------------------------------------------------------------- */
/* challenge_hypothesis                                                       */
/* -------------------------------------------------------------------------- */

test('produces a valid challenge result with an alternative created by the challenge', async () => {
  const createModelChallengeHypothesis = requireExport('createModelChallengeHypothesis');
  const { port, requests } = fakePort([
    {
      alternative: { id: 'alt-1', statement: 'the dependency, not the deploy' },
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
  const challenge = createModelChallengeHypothesis({ port, at });
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
      alternative: { id: 'h-1', statement: 'the checkout deploy did it' },
      discriminatingTests: [
        { id: 'dt-1', predictionId: 'p-1', tool: 'logs.search', input: {}, cost: 'cheap' },
      ],
    },
  ]);
  const challenge = createModelChallengeHypothesis({ port, at });
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
      alternative: { id: 'alt-1', statement: 'the dependency, not the deploy' },
      discriminatingTests: [],
    },
  ]);
  const challenge = createModelChallengeHypothesis({ port, at });
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
/* D3: the asymmetry between the two channels, pinned                         */
/* -------------------------------------------------------------------------- */

test('folds the two wrapped roles into llmCallsUsed through the graph', async () => {
  const createModelGenerateHypotheses = requireExport('createModelGenerateHypotheses');
  const createModelInterpretResidualEvidence = requireExport(
    'createModelInterpretResidualEvidence',
  );
  const { port } = fakePort([
    { hypotheses: [{ id: 'h-1', statement: 'a cause' }] },
    { assessments: [] },
  ]);

  const nodes = Object.fromEntries(
    lifecycleNodes.map((name) => [name, async () => ({})]),
  );
  nodes.generate_hypotheses = createModelGenerateHypotheses({ port, at });
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
                  alternative: { id: 'alt-1', statement: 'another cause entirely' },
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

  const challenge = createModelChallengeHypothesis({ port, at });
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
    { hypotheses: [{ id: 'h-model-1', statement: 'a cause the model named' }] },
  ]);

  const nodes = Object.fromEntries(
    lifecycleNodes.map((name) => [name, async () => ({})]),
  );
  nodes.generate_hypotheses = createModelGenerateHypotheses({ port, at });
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
        evidenceId: 'e-1',
        hypothesisId: 'h-1',
        predictionId: null,
        effect: 'supports',
        strength: 'high',
        rationale: 'the evidence bears on the hypothesis',
      }],
    },
  ]);

  const result = await createModelInterpretResidualEvidence({ port, at })(initialState());

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
      const node = make({ port: capturingPort, at });
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
      alternative: { id: 'alt-1', statement: 'a different cause' },
      discriminatingTests: [],
    },
  ]);

  for (const [name, answer] of roles) {
    const { port, requests } = fakePort([answer]);
    const node = requireExport(name)({ port, at });
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
