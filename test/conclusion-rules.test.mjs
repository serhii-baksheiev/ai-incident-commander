/**
 * AIC-119 (slice A): the pure conclusion-validation rule.
 *
 * AIC-119 adds a fourth model role — evidence-constrained conclusion
 * composition — whose model output must be validated deterministically, the
 * same way every other model-backed role in this system is: a schema-valid
 * but self-contradictory answer is a measured refusal, never passed through.
 *
 * The rule lives in `packages/domain` rather than in the role that will use
 * it, because `packages/roles/src/naive-role.ts` ALREADY enforces the
 * cause-count half of this rule today (`requireCauseCount`), and the future
 * conclusion role needs the same rule again. `.claude/rules/invariants.md`,
 * "one mechanism, one implementation": a rule two callers need is written
 * once, in the layer both can import, not copied.
 *
 * This file tests only the pure domain rule against a FAKE shape — no model
 * port, no provider, nothing that reaches the network — plus one
 * correspondence row that drives the REAL naive role (which does not yet
 * delegate to this rule) to prove today's naive-role wording and the new
 * domain wording agree, so a future refactor that makes naive-role delegate
 * to `conclusionCauseCountViolation` cannot silently change what the arm
 * refuses.
 *
 * The three cause-count reason texts asserted below are typed out as
 * literals, copied from `packages/roles/src/naive-role.ts`'s
 * `requireCauseCount` by hand, not imported from either module: an
 * independent oracle, per `.claude/rules/invariants.md` ("the independent
 * oracle invariant") — a test of a validation rule must not ask the rule
 * itself, or the module beside it, what the right answer is.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as roles from '@aic/roles';

/* -------------------------------------------------------------------------- */
/* Export guards — a typeof check, so a missing export fails as a clear       */
/* assertion on every row that needs it, not vacuously (e.g. undefined(...)   */
/* throwing a TypeError that looks like a bug in the test itself).            */
/* -------------------------------------------------------------------------- */

function causeCountViolation(conclusion) {
  assert.equal(
    typeof domain.conclusionCauseCountViolation,
    'function',
    '@aic/domain must export conclusionCauseCountViolation as a function',
  );
  return domain.conclusionCauseCountViolation(conclusion);
}

function violation(args) {
  assert.equal(
    typeof domain.conclusionViolation,
    'function',
    '@aic/domain must export conclusionViolation as a function',
  );
  return domain.conclusionViolation(args);
}

/* -------------------------------------------------------------------------- */
/* Shared fixtures                                                            */
/* -------------------------------------------------------------------------- */

const HYPOTHESES = Object.freeze([
  Object.freeze({ id: 'h-1', statement: 'the checkout deploy introduced a config drift', createdBy: 'initial' }),
  Object.freeze({ id: 'h-2', statement: 'the connection pool was undersized', createdBy: 'initial' }),
]);

const EVIDENCE = Object.freeze([
  Object.freeze({
    id: 'e-1',
    trialId: 'trial-1',
    kind: 'deploy',
    source: 'deploy-log',
    observedAt: '2026-01-01T00:00:00.000Z',
    statement: 'checkout-v42 rolled out at 00:00',
    rawRef: 'ref-1',
  }),
  Object.freeze({
    id: 'e-2',
    trialId: 'trial-2',
    kind: 'metric',
    source: 'metrics-svc',
    observedAt: '2026-01-01T00:05:00.000Z',
    statement: 'connection pool exhausted at 00:05',
    rawRef: 'ref-2',
  }),
]);

function rootCauseConclusion() {
  return {
    kind: 'root-cause',
    causes: [
      { hypothesisId: 'h-1', cause: { component: 'checkout-service', mechanism: 'config-drift' }, evidenceIds: ['e-1'] },
    ],
  };
}

function multipleCausesConclusion() {
  return {
    kind: 'multiple-causes',
    causes: [
      { hypothesisId: 'h-1', cause: { component: 'checkout-service', mechanism: 'config-drift' }, evidenceIds: ['e-1'] },
      { hypothesisId: 'h-2', cause: { component: 'checkout-service', mechanism: 'capacity-exhaustion' }, evidenceIds: ['e-2'] },
    ],
  };
}

function inconclusiveConclusion() {
  return { kind: 'inconclusive', causes: [] };
}

function noIncidentConclusion() {
  return { kind: 'no-incident', causes: [] };
}

/* -------------------------------------------------------------------------- */
/* conclusionCauseCountViolation — valid rows                                 */
/* -------------------------------------------------------------------------- */

test('conclusionCauseCountViolation: a root-cause conclusion with exactly one cause is valid', () => {
  assert.equal(causeCountViolation(rootCauseConclusion()), undefined);
});

test('conclusionCauseCountViolation: a multiple-causes conclusion with two causes is valid', () => {
  assert.equal(causeCountViolation(multipleCausesConclusion()), undefined);
});

test('conclusionCauseCountViolation: an inconclusive conclusion with zero causes is valid', () => {
  assert.equal(causeCountViolation(inconclusiveConclusion()), undefined);
});

test('conclusionCauseCountViolation: a no-incident conclusion with zero causes is valid', () => {
  assert.equal(causeCountViolation(noIncidentConclusion()), undefined);
});

/* -------------------------------------------------------------------------- */
/* conclusionCauseCountViolation — the three exact reason texts               */
/* -------------------------------------------------------------------------- */

test("conclusionCauseCountViolation: an inconclusive conclusion naming one cause reports the exact naive-role text", () => {
  const conclusion = { kind: 'inconclusive', causes: rootCauseConclusion().causes };
  assert.equal(
    causeCountViolation(conclusion),
    'a inconclusive conclusion names no cause, and this one names 1',
  );
});

test("conclusionCauseCountViolation: a no-incident conclusion naming two causes reports the exact naive-role text", () => {
  const conclusion = { kind: 'no-incident', causes: multipleCausesConclusion().causes };
  assert.equal(
    causeCountViolation(conclusion),
    'a no-incident conclusion names no cause, and this one names 2',
  );
});

test("conclusionCauseCountViolation: a root-cause conclusion naming zero causes reports the exact naive-role text", () => {
  const conclusion = { kind: 'root-cause', causes: [] };
  assert.equal(
    causeCountViolation(conclusion),
    'a root-cause conclusion names exactly one cause, and this one names 0',
  );
});

test("conclusionCauseCountViolation: a root-cause conclusion naming two causes reports the exact naive-role text", () => {
  const conclusion = { kind: 'root-cause', causes: multipleCausesConclusion().causes };
  assert.equal(
    causeCountViolation(conclusion),
    'a root-cause conclusion names exactly one cause, and this one names 2',
  );
});

test("conclusionCauseCountViolation: a multiple-causes conclusion naming zero causes reports the exact naive-role text", () => {
  const conclusion = { kind: 'multiple-causes', causes: [] };
  assert.equal(
    causeCountViolation(conclusion),
    'a multiple-causes conclusion names at least two causes, and this one names 0',
  );
});

test("conclusionCauseCountViolation: a multiple-causes conclusion naming one cause reports the exact naive-role text", () => {
  const conclusion = { kind: 'multiple-causes', causes: rootCauseConclusion().causes };
  assert.equal(
    causeCountViolation(conclusion),
    'a multiple-causes conclusion names at least two causes, and this one names 1',
  );
});

/* -------------------------------------------------------------------------- */
/* conclusionViolation — valid rows, one per kind                             */
/* -------------------------------------------------------------------------- */

test('conclusionViolation: a valid root-cause conclusion is undefined', () => {
  assert.equal(
    violation({ conclusion: rootCauseConclusion(), hypotheses: HYPOTHESES, evidence: EVIDENCE, stopKind: 'sufficient' }),
    undefined,
  );
});

test('conclusionViolation: a valid multiple-causes conclusion is undefined', () => {
  assert.equal(
    violation({ conclusion: multipleCausesConclusion(), hypotheses: HYPOTHESES, evidence: EVIDENCE, stopKind: 'sufficient' }),
    undefined,
  );
});

test('conclusionViolation: a valid inconclusive conclusion with zero causes is undefined', () => {
  assert.equal(
    violation({ conclusion: inconclusiveConclusion(), hypotheses: HYPOTHESES, evidence: EVIDENCE, stopKind: 'ambiguous' }),
    undefined,
  );
});

test("conclusionViolation: a valid no-incident conclusion under stopKind 'sufficient' is undefined", () => {
  assert.equal(
    violation({ conclusion: noIncidentConclusion(), hypotheses: HYPOTHESES, evidence: EVIDENCE, stopKind: 'sufficient' }),
    undefined,
  );
});

test("conclusionViolation: a no-incident conclusion under stopKind 'stalled' is allowed — only tools-unavailable forbids it", () => {
  assert.equal(
    violation({ conclusion: noIncidentConclusion(), hypotheses: HYPOTHESES, evidence: EVIDENCE, stopKind: 'stalled' }),
    undefined,
  );
});

/* -------------------------------------------------------------------------- */
/* conclusionViolation — one row per violation (1)-(6)                        */
/* -------------------------------------------------------------------------- */

test('conclusionViolation (1): a cause-count mismatch is reported, with the same text as conclusionCauseCountViolation', () => {
  const conclusion = { kind: 'root-cause', causes: [] };
  const reason = violation({ conclusion, hypotheses: HYPOTHESES, evidence: EVIDENCE, stopKind: 'sufficient' });
  assert.equal(reason, 'a root-cause conclusion names exactly one cause, and this one names 0');
});

test('conclusionViolation (2): the same hypothesisId named by two causes is refused', () => {
  const conclusion = {
    kind: 'multiple-causes',
    causes: [
      { hypothesisId: 'h-1', cause: { component: 'a', mechanism: 'config-drift' }, evidenceIds: ['e-1'] },
      { hypothesisId: 'h-1', cause: { component: 'b', mechanism: 'config-drift' }, evidenceIds: ['e-2'] },
    ],
  };
  const reason = violation({ conclusion, hypotheses: HYPOTHESES, evidence: EVIDENCE, stopKind: 'sufficient' });
  assert.ok(reason !== undefined, 'two causes sharing one hypothesisId must be refused');
  assert.match(reason, /hypothes/i);
  assert.match(reason, /h-1/, 'the offending hypothesisId must be named in the reason');
});

test('conclusionViolation (3): a cause whose hypothesisId names no given hypothesis is refused', () => {
  const conclusion = {
    kind: 'root-cause',
    causes: [{ hypothesisId: 'h-does-not-exist', cause: { component: 'a', mechanism: 'config-drift' }, evidenceIds: ['e-1'] }],
  };
  const reason = violation({ conclusion, hypotheses: HYPOTHESES, evidence: EVIDENCE, stopKind: 'sufficient' });
  assert.ok(reason !== undefined, 'a fabricated hypothesisId must be refused');
  assert.match(reason, /hypothes/i);
  assert.match(reason, /h-does-not-exist/, 'the fabricated id must be named in the reason');
});

test('conclusionViolation (4): a cause with an empty evidenceIds is refused', () => {
  const conclusion = {
    kind: 'root-cause',
    causes: [{ hypothesisId: 'h-1', cause: { component: 'a', mechanism: 'config-drift' }, evidenceIds: [] }],
  };
  const reason = violation({ conclusion, hypotheses: HYPOTHESES, evidence: EVIDENCE, stopKind: 'sufficient' });
  assert.ok(reason !== undefined, 'a cause with no cited evidence must be refused');
  assert.match(reason, /evidence/i);
});

test('conclusionViolation (5): an evidence id that names no given evidence item is refused', () => {
  const conclusion = {
    kind: 'root-cause',
    causes: [{ hypothesisId: 'h-1', cause: { component: 'a', mechanism: 'config-drift' }, evidenceIds: ['e-does-not-exist'] }],
  };
  const reason = violation({ conclusion, hypotheses: HYPOTHESES, evidence: EVIDENCE, stopKind: 'sufficient' });
  assert.ok(reason !== undefined, 'a fabricated evidence id must be refused');
  assert.match(reason, /evidence/i);
  assert.match(reason, /e-does-not-exist/, 'the fabricated id must be named in the reason');
});

test("conclusionViolation (6): kind 'no-incident' under stopKind 'tools-unavailable' is refused — tools-unavailable is never 'problem absent' (docs/incident-commander-architecture-v1.md section 8 rule 4)", () => {
  const conclusion = noIncidentConclusion();
  const reason = violation({ conclusion, hypotheses: HYPOTHESES, evidence: EVIDENCE, stopKind: 'tools-unavailable' });
  assert.ok(reason !== undefined, "'no-incident' under 'tools-unavailable' must be refused");
  assert.match(reason, /no-incident/i);
  assert.match(reason, /tools-unavailable/i);
});

/* -------------------------------------------------------------------------- */
/* conclusionViolation — ordering: (1) is reported ahead of (5)               */
/* -------------------------------------------------------------------------- */

test('conclusionViolation: a conclusion violating both (1) cause-count and (5) a fabricated evidence id reports (1) first', () => {
  const conclusion = {
    kind: 'root-cause', // exactly one cause required
    causes: [
      { hypothesisId: 'h-1', cause: { component: 'a', mechanism: 'config-drift' }, evidenceIds: ['e-does-not-exist'] },
      { hypothesisId: 'h-2', cause: { component: 'b', mechanism: 'config-drift' }, evidenceIds: ['e-1'] },
    ],
  };
  const reason = violation({ conclusion, hypotheses: HYPOTHESES, evidence: EVIDENCE, stopKind: 'sufficient' });
  assert.equal(
    reason,
    'a root-cause conclusion names exactly one cause, and this one names 2',
    'the cause-count violation must be reported ahead of the fabricated evidence id, even though this conclusion violates both',
  );
});

/* -------------------------------------------------------------------------- */
/* conclusionViolation — escaping and truncation of a hostile id              */
/* -------------------------------------------------------------------------- */

test('conclusionViolation: a hostile fabricated hypothesisId (quotes, newline, 500 chars) is named escaped and truncated to 80 chars', () => {
  const hostileId = `"quoted"\nline-two-${'x'.repeat(500)}`;
  assert.ok(hostileId.length > 500, 'the fixture id must exceed 500 characters');

  const conclusion = {
    kind: 'root-cause',
    causes: [{ hypothesisId: hostileId, cause: { component: 'a', mechanism: 'config-drift' }, evidenceIds: ['e-1'] }],
  };
  const reason = violation({ conclusion, hypotheses: HYPOTHESES, evidence: EVIDENCE, stopKind: 'sufficient' });

  assert.ok(reason !== undefined, 'a fabricated hypothesisId must still be refused when it is hostile input');
  // The first 80 characters of the fixture hold exactly 62 x's, so a run of 63
  // or more can only come from the part truncation must drop.
  assert.doesNotMatch(
    reason,
    /x{63,}/,
    'the id must be truncated to 80 characters: nothing past them may reach the reason',
  );
  // Escaped the same way naive-role's refuseUnknownKeys names keys:
  // JSON.stringify(name.slice(0, 80)).
  const expectedEscaped = JSON.stringify(hostileId.slice(0, 80));
  assert.ok(
    reason.includes(expectedEscaped),
    `the reason must carry the id JSON-escaped and truncated to 80 chars: ${JSON.stringify(reason)}`,
  );
  assert.ok(
    !reason.includes('\n'),
    'a raw newline from a hostile id must never reach the reason text',
  );
});

/* -------------------------------------------------------------------------- */
/* Correspondence: today's naive-role wording matches the domain wording      */
/* -------------------------------------------------------------------------- */

/**
 * Reused from naive-role.test.mjs's `fakePort` and `baseAnswer`: a port that
 * answers with a scripted body, in the same shape `roles-model-nodes.test.mjs`
 * and `naive-role.test.mjs` both already use. Duplicated rather than
 * imported: naive-role.test.mjs exports nothing, and its own sibling probes
 * (`copyForBoundaryProbe`) accept the same duplication for the same reason.
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

const MECHANISMS = Object.freeze(['config-drift', 'capacity-exhaustion']);
const INCIDENT_ID = 'incident-naive-1';

function sampleEntries() {
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

function baseAnswer() {
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

test(
  "correspondence: packages/roles/src/naive-role.ts's cause-count refusal produces the exact same text conclusionCauseCountViolation is required to — this row passes TODAY, before the domain export exists, and must keep passing once naive-role delegates to it",
  async () => {
    assert.equal(
      typeof roles.createModelNaiveInvestigation,
      'function',
      '@aic/roles must export createModelNaiveInvestigation',
    );
    assert.equal(
      typeof roles.ModelRoleOutputError,
      'function',
      '@aic/roles must export ModelRoleOutputError',
    );

    const answer = baseAnswer();
    answer.conclusion.causes = []; // root-cause naming zero causes
    const { port } = fakePort([answer]);
    const node = roles.createModelNaiveInvestigation({ port, mechanisms: MECHANISMS });

    await assert.rejects(
      () => node({ incidentId: INCIDENT_ID, entries: sampleEntries() }),
      (error) => {
        assert.ok(error instanceof roles.ModelRoleOutputError);
        assert.equal(error.role, 'naive_investigation');
        assert.match(
          error.message,
          /a root-cause conclusion names exactly one cause, and this one names 0/,
          `the naive role's own wording is the independent oracle here — it must not have drifted from the literal this suite pins: ${error.message}`,
        );
        return true;
      },
    );
  },
);
