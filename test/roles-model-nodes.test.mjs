/**
 * AIC-94, steps 3 and 4: the three reference-model-backed investigation roles.
 *
 * Every assertion here runs against a FAKE port. The roles are written to
 * `ModelPort`, which names no provider, so the whole role layer is decidable
 * with no network and no credential — which is also why these roles can be
 * exercised at all in an environment that has neither.
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
  incident: { id: 'incident-model-roles' },
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
