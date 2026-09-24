/**
 * The canonical `derive_hypothesis_state` node refuses state whose assessments
 * name evidence, a hypothesis or a prediction the investigation does not hold.
 * An assessment id can originate from a model role, so every refusal names the
 * offending id escaped and truncated, never raw.
 *
 * Each dangling kind is its own row. An unknown hypothesis is the one the
 * domain's status derivation would silently skip (it filters assessments by
 * hypothesis), so that row guards a refusal the node must make itself.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as graph from '@aic/graph';

function node() {
  assert.equal(
    typeof graph.createDeriveHypothesisState,
    'function',
    '@aic/graph must export createDeriveHypothesisState',
  );
  return graph.createDeriveHypothesisState();
}

const HOSTILE = `"quoted"\nline-two-${'x'.repeat(500)}`;

function state({ assessments, predictions = [] }) {
  return {
    incident: { id: 'incident-opaque-1' },
    hypotheses: [
      { id: 'h-1', statement: 'first cause', createdBy: 'initial' },
      { id: 'h-2', statement: 'second cause', createdBy: 'initial' },
    ],
    predictions,
    tests: [],
    trials: [],
    evidence: [
      { id: 'e-1', trialId: 'trial-1', kind: 'metric', source: 'metrics', statement: 'errors rose', observedAt: '2026-01-01T00:00:00.000Z' },
    ],
    assessments,
    control: { statusRulesVersion: domain.STATUS_RULES_VERSION },
  };
}

function assessment(overrides) {
  return {
    id: 'a-1',
    evidenceId: 'e-1',
    hypothesisId: 'h-1',
    effect: 'supports',
    strength: 'high',
    rationale: 'bears on it',
    producedBy: 'rule',
    ...overrides,
  };
}

function assertEscapedRefusal(fn) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes('\n'), 'a raw newline from the id must never reach the message');
    assert.doesNotMatch(error.message, /x{63,}/, 'the id must be truncated, never carried whole');
    return true;
  });
}

test('derive_hypothesis_state refuses an assessment naming evidence the state does not carry, naming the id escaped', () => {
  assertEscapedRefusal(() => node()(state({ assessments: [assessment({ evidenceId: HOSTILE })] })));
});

test('derive_hypothesis_state refuses an assessment naming a hypothesis the state does not carry, which status derivation alone would skip', () => {
  assertEscapedRefusal(() => node()(state({ assessments: [assessment({ hypothesisId: HOSTILE })] })));
});

test('derive_hypothesis_state refuses an assessment naming a prediction that belongs to another hypothesis', () => {
  // The prediction exists, but under h-2. Only the ownership clause separates
  // this from a valid reference, and the node's own wording separates its
  // refusal from the status derivation's older, unescaped one.
  const predictions = [
    { id: HOSTILE, hypothesisId: 'h-2', statement: 'x', expectedIfTrue: [], expectedIfFalse: [], status: 'untested' },
  ];
  const run = () => node()(state({ predictions, assessments: [assessment({ predictionId: HOSTILE })] }));
  assertEscapedRefusal(run);
  assert.throws(run, /^Error: derive_hypothesis_state: an assessment names a prediction/);
});

test('derive_hypothesis_state returns an empty result for a state whose assessments all name what the state holds', () => {
  assert.deepEqual(node()(state({ assessments: [assessment({})] })), {});
});
