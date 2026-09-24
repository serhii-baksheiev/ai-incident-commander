/**
 * AIC-119 slice 5 part B (owner ruling D1, item 6): the preregistration
 * addendum must state "the known single-decisive-evidence confound, in
 * particular dependency-caused-incident-b and challenge-changes-leader if a
 * fresh fixture check confirms it". This file IS that fresh fixture check,
 * run mechanically against the corpus rather than asserted in prose.
 *
 * The confound: a scenario is single-decisive-evidence when the corpus's own
 * `ok` tool results carry at most one distinct evidence id that both (a) the
 * structural ground truth expects
 * (`STRUCTURAL_GROUND_TRUTH[id].expectedEvidenceIds`,
 * `packages/evals/src/structural-ground-truth.ts`) and (b) is not also
 * labelled misleading in the same scenario
 * (`STRUCTURAL_GROUND_TRUTH[id].misleadingEvidenceIds`). With one non-
 * misleading decisive id, corroboration's two-independent-supports
 * requirement (`STATUS_RULES['v0.2'].hypothesis.rules.corroborated`,
 * `packages/domain/src/status-rules.ts`) cannot be met from that evidence
 * alone, whatever the graph does with it.
 *
 * `okEvidenceIdsOf` reads the fixture's `ok` results directly — the same
 * shape `replay-scenarios.test.mjs` walks (`result.status === 'ok'` and
 * `result.output` items carrying an `id`) — rather than trusting
 * `expectedEvidenceIds` at face value, so this measures the corpus, not the
 * table's own claim about the corpus.
 *
 * Every count below is a literal, measured once against this tree
 * (`node --import ./test/fixtures/no-ambient-tracing.mjs --test
 * test/prereg-confounds.test.mjs`) and written here, per
 * `.claude/rules/invariants.md` ("independent-oracle invariant"): the
 * assertions do not derive their expectation from
 * `STRUCTURAL_GROUND_TRUTH` a second time, they recompute it from the
 * fixture's own tool outputs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as evals from '@aic/evals';

function requireScenario(id) {
  const scenario = evals.REPLAY_SCENARIOS.find((candidate) => candidate.id === id);
  assert.ok(scenario, `${id} must be present in evals.REPLAY_SCENARIOS`);
  return scenario;
}

/** Distinct evidence ids the scenario's fixture actually returns as `ok`. */
function okEvidenceIdsOf(scenario) {
  const ids = new Set();
  for (const entry of scenario.fixture.entries) {
    if (entry.result.status !== 'ok' || !Array.isArray(entry.result.output)) continue;
    for (const item of entry.result.output) {
      if (item !== null && typeof item === 'object' && typeof item.id === 'string') {
        ids.add(item.id);
      }
    }
  }
  return ids;
}

/**
 * Distinct ok evidence ids that are both expected and not misleading for the
 * scenario — the count the confound is about.
 */
function decisiveNonMisleadingIdsOf(scenarioId) {
  const scenario = requireScenario(scenarioId);
  const okIds = okEvidenceIdsOf(scenario);
  const truth = evals.STRUCTURAL_GROUND_TRUTH[scenarioId];
  assert.ok(truth, `${scenarioId} must have a STRUCTURAL_GROUND_TRUTH entry`);
  const misleading = new Set(truth.misleadingEvidenceIds ?? []);
  return [...okIds].filter(
    (id) => truth.expectedEvidenceIds.includes(id) && !misleading.has(id),
  );
}

/*
 * Measured directly against this tree:
 *   dependency-caused-incident-b -> ['inventory-api-pool-saturation']  (1)
 *   challenge-changes-leader     -> ['inventory-api-challenge-saturation'] (1)
 * Both are at or under the confound threshold of 1 decisive, non-misleading
 * evidence id, which is the fresh fixture check owner ruling D1 item 6 asks
 * for before the confound can be named in the preregistration addendum.
 */
for (const scenarioId of ['dependency-caused-incident-b', 'challenge-changes-leader']) {
  test(`${scenarioId} carries at most one distinct, non-misleading, expected ok evidence id (single-decisive-evidence confound)`, () => {
    const decisiveIds = decisiveNonMisleadingIdsOf(scenarioId);
    assert.ok(
      decisiveIds.length <= 1,
      `${scenarioId} must carry at most one decisive non-misleading evidence id for the confound named in owner ruling D1 item 6 to hold; measured ${decisiveIds.length}: ${JSON.stringify(decisiveIds)}`,
    );
  });
}

/*
 * Measured directly against this tree: multiple-plausible-causes' fixture
 * carries exactly two distinct `ok` evidence ids in total
 * ('payments-error-rate-incident' from the metrics tool,
 * 'inventory-api-latency-incident' from the dependencies tool) — named here
 * as a contrast case: two independently-sourced pieces of decisive evidence,
 * not one, so the single-decisive-evidence confound this file measures does
 * not describe it.
 */
test('multiple-plausible-causes carries exactly two distinct ok evidence ids in total, in contrast to the single-decisive-evidence scenarios above', () => {
  const scenario = requireScenario('multiple-plausible-causes');
  const okIds = okEvidenceIdsOf(scenario);
  assert.equal(
    okIds.size,
    2,
    `expected exactly 2 distinct ok evidence ids for multiple-plausible-causes, measured ${okIds.size}: ${JSON.stringify([...okIds])}`,
  );
});
