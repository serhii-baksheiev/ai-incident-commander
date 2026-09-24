/**
 * AIC-119 slice F: model-originated text never reaches an error message raw.
 *
 * `quoteModelText` (`@aic/domain`, `packages/domain/src/conclusion-rules.ts`)
 * escapes and truncates a model-supplied value before it is named in a
 * refusal. This file pins twelve refusal sites that name such a value: eight
 * `refuse(...)` calls in `packages/roles/src/naive-role.ts`, one in
 * `packages/roles/src/investigation-roles.ts`'s `generate_hypotheses` (a
 * duplicate of an id the run already carries, where the run's own record can
 * carry a hostile id and the model repeats it), and three in
 * `packages/domain/src/evaluation.ts`'s `deriveHypothesisStatus`.
 *
 * The oracle is independent of `quoteModelText`: every row asserts, directly
 * against the thrown message, that it carries no raw newline and does not
 * carry the hostile value's run of 'x' characters whole (`/x{63,}/`, the same
 * check `derive-hypothesis-state.test.mjs`'s `assertEscapedRefusal` makes,
 * whose `HOSTILE` value this file copies). Each row also pins the error's type
 * and a stable prefix of its message, so a refusal that escapes correctly but
 * no longer says what was wrong cannot pass.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as roles from '@aic/roles';

import { scopedIncident } from './fixtures/scoped-incident.mjs';

function requireExport(bag, name, label) {
  assert.ok(bag[name] !== undefined, `${label} must export ${name}`);
  return bag[name];
}

const HOSTILE = `"quoted"\nline-two-${'x'.repeat(500)}`;

/** Common to every row: the hostile value never reaches the message raw. */
function assertEscaped(error, description) {
  assert.ok(
    !error.message.includes('\n'),
    `${description}: a raw newline from the hostile value must never reach the message: ${error.message}`,
  );
  assert.doesNotMatch(
    error.message,
    /x{63,}/,
    `${description}: the hostile value must be truncated, never carried whole: ${error.message}`,
  );
}

/* -------------------------------------------------------------------------- */
/* packages/roles/src/naive-role.ts                                           */
/* -------------------------------------------------------------------------- */

const MECHANISMS = Object.freeze(['config-drift', 'capacity-exhaustion']);
const INCIDENT_ID = 'incident-escaping-1';

function naiveFakePort(answer) {
  return {
    async complete() {
      return {
        text: JSON.stringify(answer),
        modelId: 'claude-under-test',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

function naiveEntries() {
  return [
    {
      status: 'ok',
      tool: 'query-logs',
      input: { service: 'checkout-logs-svc' },
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
  ];
}

/** A schema-valid, internally-consistent answer: each row mutates one field off this. */
function naiveBaseAnswer() {
  return {
    hypotheses: [{ id: 'h-1', statement: 'the checkout deploy introduced a config drift' }],
    assessments: [{ evidenceId: 'evidence-1', hypothesisId: 'h-1', effect: 'supports' }],
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
  };
}

async function assertNaiveEscapedRefusal(answer, prefixPattern, description) {
  const createModelNaiveInvestigation = requireExport(roles, 'createModelNaiveInvestigation', '@aic/roles');
  const ModelRoleOutputError = requireExport(roles, 'ModelRoleOutputError', '@aic/roles');
  const node = createModelNaiveInvestigation({ port: naiveFakePort(answer), mechanisms: MECHANISMS });

  await assert.rejects(
    () => node({ incidentId: INCIDENT_ID, entries: naiveEntries() }),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError, `${description}: must be a ModelRoleOutputError, got ${error}`);
      assert.equal(error.role, 'naive_investigation', `${description}: must name the naive role`);
      assertEscaped(error, description);
      assert.match(error.message, prefixPattern, `${description}: the refusal must still say what was wrong: ${error.message}`);
      return true;
    },
    description,
  );
}

test('naive-role: a duplicate hypothesis id is named escaped, not raw', async () => {
  const answer = naiveBaseAnswer();
  answer.hypotheses = [
    { id: HOSTILE, statement: 'first statement' },
    { id: HOSTILE, statement: 'a different statement under the same id' },
  ];
  await assertNaiveEscapedRefusal(
    answer,
    /declared hypothesis id/,
    'a duplicate hypothesis id (naive-role.ts:265)',
  );
});

test('naive-role: an assessment naming unshown evidence is named escaped, not raw', async () => {
  const answer = naiveBaseAnswer();
  answer.assessments = [{ evidenceId: HOSTILE, hypothesisId: 'h-1', effect: 'supports' }];
  await assertNaiveEscapedRefusal(
    answer,
    /an assessment names evidence that was not shown/,
    'an assessment naming unshown evidence (naive-role.ts:275)',
  );
});

test('naive-role: an assessment naming an undeclared hypothesis is named escaped, not raw', async () => {
  const answer = naiveBaseAnswer();
  answer.assessments = [{ evidenceId: 'evidence-1', hypothesisId: HOSTILE, effect: 'supports' }];
  await assertNaiveEscapedRefusal(
    answer,
    /an assessment names a hypothesis the answer did not declare/,
    'an assessment naming an undeclared hypothesis (naive-role.ts:278)',
  );
});

test('naive-role: an assessment carrying an effect outside the domain vocabulary is named escaped, not raw', async () => {
  const answer = naiveBaseAnswer();
  answer.assessments = [{ evidenceId: 'evidence-1', hypothesisId: 'h-1', effect: HOSTILE }];
  await assertNaiveEscapedRefusal(
    answer,
    /an assessment carries an effect outside the domain's/,
    'an assessment effect outside the domain vocabulary (naive-role.ts:281)',
  );
});

test('naive-role: a cause naming an undeclared hypothesis is named escaped, not raw', async () => {
  const answer = naiveBaseAnswer();
  answer.conclusion.causes[0].hypothesisId = HOSTILE;
  await assertNaiveEscapedRefusal(
    answer,
    /a cause names a hypothesis the answer did not declare/,
    'a cause naming an undeclared hypothesis (naive-role.ts:318)',
  );
});

test('naive-role: a cause citing unshown evidence is named escaped, not raw', async () => {
  const answer = naiveBaseAnswer();
  answer.conclusion.causes[0].evidenceIds = [HOSTILE];
  await assertNaiveEscapedRefusal(
    answer,
    /a cause cites evidence that was not shown/,
    'a cause citing unshown evidence (naive-role.ts:321)',
  );
});

test('naive-role: a cause mechanism outside the supplied vocabulary is named escaped, not raw', async () => {
  const answer = naiveBaseAnswer();
  answer.conclusion.causes[0].cause.mechanism = HOSTILE;
  await assertNaiveEscapedRefusal(
    answer,
    /a cause's mechanism is outside the vocabulary/,
    "a cause mechanism outside the supplied vocabulary (naive-role.ts:323)",
  );
});

test('naive-role: a stopKind outside NAIVE_STOP_KINDS is named escaped, not raw', async () => {
  const answer = naiveBaseAnswer();
  answer.stopKind = HOSTILE;
  await assertNaiveEscapedRefusal(
    answer,
    /the stop kind is not one a single call can report/,
    'a stopKind outside NAIVE_STOP_KINDS (naive-role.ts:330)',
  );
});

/* -------------------------------------------------------------------------- */
/* packages/roles/src/investigation-roles.ts (generate_hypotheses)            */
/* -------------------------------------------------------------------------- */

function graphInitialState() {
  return {
    incident: scopedIncident('incident-escaping-graph'),
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: {
      runId: 'run-escaping-graph',
      schemaVersion: requireExport(domain, 'INCIDENT_STATE_SCHEMA_VERSION', '@aic/domain'),
      statusRulesVersion: requireExport(domain, 'STATUS_RULES_VERSION', '@aic/domain'),
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

test('generate_hypotheses: a hostile id the run already carries is named escaped, not raw', async () => {
  const createModelGenerateHypotheses = requireExport(roles, 'createModelGenerateHypotheses', '@aic/roles');
  const ModelRoleOutputError = requireExport(roles, 'ModelRoleOutputError', '@aic/roles');

  const state = graphInitialState();
  state.hypotheses = [{ id: HOSTILE, statement: 'the hypothesis already under investigation', createdBy: 'initial' }];

  const port = {
    async complete() {
      return {
        text: JSON.stringify({ hypotheses: [{ id: HOSTILE, statement: 'hijacked' }] }),
        modelId: 'claude-under-test',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  const node = createModelGenerateHypotheses({ port });

  await assert.rejects(
    () => node(state),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError, `must be a ModelRoleOutputError, got ${error}`);
      assert.equal(error.role, 'generate_hypotheses', 'must name the generate_hypotheses role');
      assertEscaped(error, 'a duplicate hypothesis id the run already carries (investigation-roles.ts:389)');
      assert.match(
        error.message,
        /proposed a hypothesis id the run already carries/,
        `the refusal must still say what was wrong: ${error.message}`,
      );
      return true;
    },
    'a duplicate hypothesis id the run already carries (investigation-roles.ts:389)',
  );
});

/* -------------------------------------------------------------------------- */
/* packages/domain/src/evaluation.ts (deriveHypothesisStatus)                 */
/* -------------------------------------------------------------------------- */

function assertEscapedDomainRefusal(fn, prefixPattern, description) {
  assert.throws(
    fn,
    (error) => {
      assert.ok(error instanceof Error, `${description}: must be an Error, got ${error}`);
      assertEscaped(error, description);
      assert.match(error.message, prefixPattern, `${description}: the refusal must still say what was wrong: ${error.message}`);
      return true;
    },
    description,
  );
}

test('deriveHypothesisStatus: an unknown status-rules version is named escaped, not raw', () => {
  const deriveHypothesisStatus = requireExport(domain, 'deriveHypothesisStatus', '@aic/domain');
  assertEscapedDomainRefusal(
    () =>
      deriveHypothesisStatus({
        hypothesisId: 'h-1',
        predictions: [],
        assessments: [],
        evidence: [],
        rulesVersion: HOSTILE,
      }),
    /unknown status-rules version/,
    'an unknown status-rules version (evaluation.ts:164)',
  );
});

test('deriveHypothesisStatus: an assessment naming evidence not among the supplied evidence is named escaped, not raw', () => {
  const deriveHypothesisStatus = requireExport(domain, 'deriveHypothesisStatus', '@aic/domain');
  assertEscapedDomainRefusal(
    () =>
      deriveHypothesisStatus({
        hypothesisId: 'h-1',
        predictions: [],
        assessments: [
          {
            id: 'assessment-1',
            evidenceId: HOSTILE,
            hypothesisId: 'h-1',
            effect: 'supports',
            strength: 'high',
            rationale: 'bears on it',
            producedBy: 'rule',
            at: '2026-01-01T00:00:00.000Z',
          },
        ],
        evidence: [],
      }),
    /assessment evidenceId does not reference supplied evidence/,
    'an assessment evidenceId not among the supplied evidence (evaluation.ts:183)',
  );
});

test('deriveHypothesisStatus: an assessment naming a predictionId that is not one of this hypothesis is named escaped, not raw', () => {
  const deriveHypothesisStatus = requireExport(domain, 'deriveHypothesisStatus', '@aic/domain');
  assertEscapedDomainRefusal(
    () =>
      deriveHypothesisStatus({
        hypothesisId: 'h-1',
        predictions: [
          {
            id: 'p-1',
            hypothesisId: 'h-1',
            statement: 'x',
            expectedIfTrue: [],
            expectedIfFalse: [],
            status: 'untested',
          },
        ],
        assessments: [
          {
            id: 'assessment-1',
            evidenceId: 'e-1',
            hypothesisId: 'h-1',
            predictionId: HOSTILE,
            effect: 'supports',
            strength: 'high',
            rationale: 'bears on it',
            producedBy: 'rule',
            at: '2026-01-01T00:00:00.000Z',
          },
        ],
        evidence: [
          {
            id: 'e-1',
            trialId: 'trial-1',
            kind: 'metric',
            source: 'metrics',
            statement: 'errors rose',
            observedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    /assessment predictionId does not reference this hypothesis/,
    'an assessment predictionId not among this hypothesis’s predictions (evaluation.ts:192)',
  );
});

/* -------------------------------------------------------------------------- */
/* shared refusal helpers and the standing derivation                         */
/* -------------------------------------------------------------------------- */

test('parseJsonDocument: an answer that is not parseable JSON is refused without the answer text reaching the message raw', async () => {
  const createModelNaiveInvestigation = requireExport(roles, 'createModelNaiveInvestigation', '@aic/roles');
  const ModelRoleOutputError = requireExport(roles, 'ModelRoleOutputError', '@aic/roles');
  // A brace pair whose body JSON.parse rejects, carrying raw newlines inside
  // the part a JSON.parse error message quotes back.
  const port = {
    async complete() {
      return {
        text: `PROSE {"a"\n:\n${'x'.repeat(500)}}`,
        modelId: 'claude-under-test',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  const node = createModelNaiveInvestigation({ port, mechanisms: MECHANISMS });
  await assert.rejects(
    () => node({ incidentId: INCIDENT_ID, entries: naiveEntries() }),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError, 'a malformed answer is a ModelRoleOutputError');
      assert.match(error.message, /the answer is not parseable JSON/);
      assertEscaped(error, 'an unparseable answer (role-output.ts parseJsonDocument)');
      return true;
    },
  );
});

test('deriveHypothesisStanding: an unknown status-rules version is named escaped, not raw', () => {
  const deriveHypothesisStanding = requireExport(domain, 'deriveHypothesisStanding', '@aic/domain');
  assertEscapedDomainRefusal(
    () =>
      deriveHypothesisStanding(
        { hypotheses: [], predictions: [], assessments: [], evidence: [] },
        { rulesVersion: HOSTILE },
      ),
    /deriveHypothesisStanding: unknown status-rules version/,
    'an unknown status-rules version (hypothesis-standing.ts)',
  );
});
