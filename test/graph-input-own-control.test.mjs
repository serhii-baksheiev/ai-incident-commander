/**
 * AIC-87 — a `kind: 'start'` execution must run on the control the CALLER owns,
 * never on one `Object.prototype` supplied.
 *
 * The hazard is one shape and one shape only: an inherited ACCESSOR named like a
 * control field. `IncidentStateSchema.safeParse` returns a `control` on which
 * such a field is not an own property, so every later read of it — the graph's,
 * the checkpointer's, a node's — falls through to the prototype and gets a value
 * no caller supplied. That mechanism is asserted in the first test rather than
 * only described here, because it is the fact the whole file rests on and a zod
 * change would silently retire the guard.
 *
 * A plain inherited DATA property is harmless by comparison: the caller's own
 * value shadows it and the parse output owns the field. The second test pins
 * that, so the fix cannot be the blunt "refuse whenever `Object.prototype` has
 * anything" — which would break every honest caller running under a library that
 * extends the prototype.
 *
 * `stopKind` is included in the refusing set even though its ABSENCE from a start
 * state is entirely normal. Absence is not what is refused here: an inherited
 * accessor makes the field PRESENT to every `in` test and readable by every
 * `[[Get]]`, so a run that supplied no stop kind starts carrying one. A start
 * state with no `stopKind` and an unpolluted prototype is untouched by this — the
 * baseline of the second test is exactly that state, and it completes. `stopKind`
 * is excluded from the harmless-data-property set for the opposite reason: the
 * caller owns no value to shadow with, so an inherited data property there is the
 * sole source of the field rather than a shadowed one, which is a different
 * question this file does not answer.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INCIDENT_STATE_SCHEMA_VERSION,
  IncidentStateControlSchema,
  IncidentStateSchema,
  STATUS_RULES_VERSION,
} from '@aic/domain';
import * as graphPackage from '@aic/graph';

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

/** The stop kind `terminalStall` decides, and the only one this file uses. */
const TERMINAL_STOP_KIND = 'stalled';

/** What the polluted prototype hands out; distinct from every fixture value. */
const INHERITED_VALUE = 'inherited';

/**
 * Derived, never hand-listed: a field added to the control schema is covered by
 * this file the day it is declared, with no second list to remember.
 */
const CONTROL_FIELDS = Object.keys(IncidentStateControlSchema.shape);

/** The fields a start state legitimately owns — every one but the optional stop kind. */
const OWNED_CONTROL_FIELDS = CONTROL_FIELDS.filter(
  (field) => field !== 'stopKind',
);

/**
 * The refusal this ticket asks for: the graph's own, and it names the offending
 * field so the caller can act on it. The capture is what test 3 reads.
 */
const OWN_CONTROL_REFUSAL = /investigation control must carry its own (\w+)/;

/**
 * Every refusal the polluted run already produces today, for reasons that have
 * nothing to do with noticing the substitution — an inherited STRING simply
 * fails the field's own validator. Measured on `main` at 6f4338e, one accessor
 * per control field: 11 of the 13 fields refuse with one of these, and `runId`
 * and `phase` do not refuse at all.
 *
 * Asserting against this set is what stops "it threw, so the guard works" from
 * passing for a guard that was never written.
 */
const INCIDENTAL_REFUSALS =
  /invalid investigation execution input|incompatible persisted state|invalid logical iteration counter|invalid iteration budget|invalid llm call budget|invalid llm call counter|invalid reserved challenge budget|invalid challenge round counter|invalid resume counter|interactive runId must match/;

const initialState = () => ({
  incident: { id: 'incident-graph-input-own-control' },
  hypotheses: [],
  predictions: [],
  tests: [],
  trials: [],
  evidence: [],
  assessments: [],
  control: {
    runId: 'run-graph-input-own-control',
    schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
    statusRulesVersion: STATUS_RULES_VERSION,
    phase: 'normalizing',
    maxIterations: 4,
    llmCallBudget: 8,
    iterationsUsed: 0,
    llmCallsUsed: 0,
    resumeCount: 0,
    reservedChallengeBudget: 2,
    challengeRounds: 0,
    humanReview: false,
  },
});

/**
 * The control an undisturbed run of `fakeNodes` ends with, DECLARED rather than
 * captured from a baseline run: a baseline captured from the same code moves
 * whenever the code moves, so the comparison would hold while both were wrong.
 *
 * `iterationsUsed` is 1 because `plan_investigation` is entered once; `stopKind`
 * is what `terminalStall` decides.
 */
const EXPECTED_FINAL_CONTROL = {
  runId: 'run-graph-input-own-control',
  schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
  statusRulesVersion: STATUS_RULES_VERSION,
  phase: 'normalizing',
  maxIterations: 4,
  llmCallBudget: 8,
  iterationsUsed: 1,
  llmCallsUsed: 0,
  resumeCount: 0,
  reservedChallengeBudget: 2,
  challengeRounds: 0,
  humanReview: false,
  stopKind: TERMINAL_STOP_KIND,
};

function requireGraphFactory() {
  assert.equal(
    typeof graphPackage.createInvestigationGraph,
    'function',
    '@aic/graph must publish createInvestigationGraph({ nodes })',
  );
  return graphPackage.createInvestigationGraph;
}

const fakeNodes = () =>
  Object.fromEntries(
    lifecycleNodes.map((name) => [
      name,
      async () =>
        name === 'termination_check'
          ? { route: 'terminal', stopKind: TERMINAL_STOP_KIND }
          : {},
    ]),
  );

const runToCompletion = (graph, state) =>
  graph.execute({ kind: 'start', state }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

/**
 * Arms the hazardous shape and returns what the setter swallowed.
 *
 * A getter-only accessor substitutes just as effectively, and is deliberately
 * NOT the shape used: assigning through an inherited getter-only property throws
 * a `TypeError` in strict mode, so a run would abort on the assignment rather
 * than on the substitution, and the test would pass for the wrong reason. The
 * swallowing setter is the quiet shape — nothing throws, no own property is
 * created, and the inherited value is what everyone downstream reads.
 *
 * Callers must `delete Object.prototype[field]` in a `finally`.
 */
function armInheritedAccessor(field) {
  const swallowed = [];
  Object.defineProperty(Object.prototype, field, {
    configurable: true,
    get() {
      return INHERITED_VALUE;
    },
    set(value) {
      swallowed.push(value);
    },
  });
  return swallowed;
}

test('refuses a start state whose control field is supplied by an accessor on the prototype', async (t) => {
  const createInvestigationGraph = requireGraphFactory();

  assert.equal(
    CONTROL_FIELDS.length > 0,
    true,
    'an empty control schema would make every subtest below vacuous',
  );

  // The mechanism, asserted rather than described: the caller's own `runId`
  // survives the parse as a VALUE, but the parse output does not own the field,
  // which is what leaves every later read walking the prototype chain. If this
  // ever stops holding, the guard the tests below demand may have become
  // unnecessary — and that is a fact worth being told rather than inheriting.
  const probe = initialState();
  let parsedOwnsField;
  let parsedValue;
  try {
    armInheritedAccessor('runId');
    const parsed = IncidentStateSchema.safeParse(probe);
    assert.equal(parsed.success, true, 'the fixture state must parse');
    parsedOwnsField = Object.hasOwn(parsed.data.control, 'runId');
    parsedValue = parsed.data.control.runId;
  } finally {
    delete Object.prototype.runId;
  }
  assert.equal(
    parsedOwnsField,
    false,
    'the parse is what drops ownership; if it now returns an own field, re-measure this whole file',
  );
  assert.equal(
    parsedValue,
    INHERITED_VALUE,
    'the substitution under test is the parse output reading back the prototype value',
  );

  for (const field of CONTROL_FIELDS) {
    await t.test(`refuses an inherited ${field} accessor`, async () => {
      // Built before the pollution is armed: a graph constructed under a
      // polluted prototype could fail for reasons inside LangGraph that have
      // nothing to do with the control the caller supplied.
      const graph = createInvestigationGraph({ nodes: fakeNodes() });
      const state = initialState();

      let outcome;
      try {
        armInheritedAccessor(field);
        outcome = await runToCompletion(graph, state);
      } finally {
        // `finally`, not `t.after`: a subtest's hooks run at the END of the
        // parent, so a deferred cleanup would leave this field's accessor armed
        // for every subtest after it and they would fail on each other's
        // pollution instead of their own.
        delete Object.prototype[field];
      }

      assert.equal(
        'error' in outcome,
        true,
        `a start state whose ${field} is supplied by the prototype must be refused, not run to completion carrying ${JSON.stringify(
          outcome.value?.control?.[field],
        )}`,
      );

      const message = outcome.error.message;
      assert.doesNotMatch(
        message,
        INCIDENTAL_REFUSALS,
        `refusing ${field} because an inherited string fails its validator is not the guard working: ${message}`,
      );

      const named = OWN_CONTROL_REFUSAL.exec(message);
      assert.notEqual(
        named,
        null,
        `refusing an inherited ${field} must say so in the graph's own words, not: ${message}`,
      );
      assert.equal(
        named[1],
        field,
        `the refusal named ${named?.[1]} while the prototype supplied ${field}`,
      );
    });
  }
});

test('still accepts a start state when the prototype carries a plain data property', async (t) => {
  const createInvestigationGraph = requireGraphFactory();

  const baseline = await runToCompletion(
    createInvestigationGraph({ nodes: fakeNodes() }),
    initialState(),
  );
  assert.equal(
    'error' in baseline,
    false,
    `an undisturbed start state must complete: ${baseline.error?.message ?? ''}`,
  );
  assert.deepStrictEqual(
    baseline.value.control,
    EXPECTED_FINAL_CONTROL,
    'the declared expectation must describe what an undisturbed run really ends with',
  );

  for (const field of OWNED_CONTROL_FIELDS) {
    await t.test(`ignores an inherited ${field} data property`, async () => {
      const graph = createInvestigationGraph({ nodes: fakeNodes() });
      const state = initialState();

      let outcome;
      try {
        Object.defineProperty(Object.prototype, field, {
          configurable: true,
          writable: true,
          enumerable: false,
          value: INHERITED_VALUE,
        });
        outcome = await runToCompletion(graph, state);
      } finally {
        delete Object.prototype[field];
      }

      assert.equal(
        'error' in outcome,
        false,
        `a shadowed inherited ${field} is harmless and must not be refused: ${outcome.error?.message ?? ''}`,
      );
      assert.equal(
        Object.hasOwn(outcome.value.control, field),
        true,
        `the persisted control must own ${field} rather than borrow it`,
      );
      assert.deepStrictEqual(
        outcome.value.control,
        EXPECTED_FINAL_CONTROL,
        `an inherited ${field} data property must leave the caller's own values in place`,
      );
    });
  }
});

test('names the field it refused', async () => {
  const createInvestigationGraph = requireGraphFactory();
  // `runId` is the representative case because it is the worst one: today it
  // does not refuse at all, and the run completes under an identity nobody
  // supplied.
  const field = 'runId';
  const graph = createInvestigationGraph({ nodes: fakeNodes() });
  const state = initialState();

  let outcome;
  try {
    armInheritedAccessor(field);
    outcome = await runToCompletion(graph, state);
  } finally {
    delete Object.prototype[field];
  }

  assert.equal(
    'error' in outcome,
    true,
    'an inherited runId accessor must be refused',
  );
  assert.match(
    outcome.error.message,
    new RegExp(field),
    `a caller cannot act on a refusal that does not say which field: ${outcome.error.message}`,
  );

  // A message that listed every control field would technically contain the
  // offender's name and identify nothing.
  assert.deepStrictEqual(
    CONTROL_FIELDS.filter(
      (other) => other !== field && outcome.error.message.includes(other),
    ),
    [],
    'the refusal must name the one field the prototype supplied, not the whole schema',
  );
});
