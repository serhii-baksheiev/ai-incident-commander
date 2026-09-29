/**
 * AIC-146 sub-slice b2: a golden characterization of what the deterministic
 * lane's graph arm (`scripts/lane-arms.mjs`'s `scriptedNodes`) produces over
 * every scenario in `@aic/evals`' `REPLAY_SCENARIOS`, captured at the commit
 * b2 starts from (AIC-146 b1, f10ab64). b2 changes how evidence carries
 * provenance; this row is the proof that the change is inert for a lane that
 * never supplies any provenance at all — replay fixtures and the scripted
 * reasoning arm carry no outcome-level or item-level `provenance` field, so
 * `ingestEvidence`'s new refusal and stamping paths are simply never taken on
 * this arm, and the evidence and trials it produces must stay byte-for-byte
 * identical.
 *
 * Determinism, checked before trusting a frozen hash: every id `scriptedNodes`
 * and the canonical graph nodes derive is either copied straight out of a
 * scenario's own fixture (`packages/evals/src/replay-scenarios.ts`) or a pure
 * function of `runId`/`testId`/`attempt` (`deriveTrialId`, `deriveEvidenceId`,
 * `createScriptedReasoning`'s own `leader-${runId}` family) — nothing here
 * reads the clock or calls `crypto.randomUUID`. `runId` below is a fixed
 * string per scenario, not the benchmark plan helper's own `randomUUID()`,
 * so the whole sweep is reproducible across processes. The first row below
 * checks that directly — two sweeps in the same process must hash
 * identically — before the second row compares either against the frozen
 * constant.
 *
 * `hashDeterministicSweep` measures TRIALS, not evidence: driven through the
 * real kernel from an empty `tests: []` state, the scripted-control arm's own
 * `plan_investigation` never plans a request any `REPLAY_SCENARIOS` fixture
 * entry answers exactly, so every one of its ten trials comes back
 * `unavailable` and `ingestEvidence`'s `ok` branch — the one AIC-146 b2
 * changes — is never reached on this arm. `hashPlannedReplaySweep` below is
 * the second, evidence-bearing arm: it plans one test per fixture entry,
 * using the entry's own `toolId`/`input`, so `createPlannedReplayExecutor`'s
 * EXACT match (`packages/tools/replay/index.ts`) replays every recorded entry
 * verbatim and reaches `ok`. Both sweeps are frozen at the same commit
 * (b1, f10ab64) and both stay byte-for-byte identical there, because neither
 * arm's fixtures carry a `provenance` field at any level.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as evals from '@aic/evals';
import * as graph from '@aic/graph';

import { scriptedNodes } from '../scripts/lane-arms.mjs';

/**
 * Captured once, at f10ab64 (AIC-146 b1) — the commit this sub-slice starts
 * from. A change to this constant in the same PR as a change to b2's
 * ingestion path is itself the finding a reviewer reads that PR against.
 */
const GOLDEN_SHA256 = 'd718aed022d3a1ce6aebf2a79e6b0d4cfaa04f0e8e9be8e183e55d3866fa3a0c';

/**
 * Captured the same way as `GOLDEN_SHA256` above, at the same commit
 * (f10ab64, AIC-146 b1) — measured directly against that commit's built
 * packages in a separate `git worktree`, not derived from this commit's own
 * code.
 */
const PLANNED_SWEEP_GOLDEN_SHA256 = '910cc0d6332002c9f85bf5f6fbcd03d58e9437f225f1377e5a8473f9019a11a7';

function initialStateFor(input) {
  return {
    incident: {
      id: evals.opaqueIncidentId(input.runId),
      primaryScope: evals.BENCHMARK_PRIMARY_SCOPE,
    },
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: {
      runId: input.runId,
      schemaVersion: domain.INCIDENT_STATE_SCHEMA_VERSION,
      statusRulesVersion: domain.STATUS_RULES_VERSION,
      phase: 'normalizing',
      maxIterations: evals.BENCHMARK_BUDGET_POLICY.maxIterations,
      llmCallBudget: evals.BENCHMARK_BUDGET_POLICY.llmCallBudget,
      reservedChallengeBudget: evals.BENCHMARK_BUDGET_POLICY.reservedChallengeBudget,
      challengeRounds: 0,
      iterationsUsed: 0,
      llmCallsUsed: 0,
      resumeCount: 0,
      humanReview: false,
    },
  };
}

function byId(a, b) {
  return a.id.localeCompare(b.id);
}

/**
 * Runs the deterministic graph arm to completion over every replay scenario
 * and hashes the canonical JSON of the resulting evidence and trials, keyed
 * by scenario id. Evidence and trials are each sorted by id before hashing,
 * independently of the order the graph happened to emit them in.
 */
async function hashDeterministicSweep() {
  const results = [];
  for (const scenario of evals.REPLAY_SCENARIOS) {
    const runId = `lane-arms-golden-${scenario.id}`;
    const input = {
      experimentId: 'aic146-b2-golden',
      exampleId: `${scenario.id}-golden`,
      scenarioId: scenario.id,
      fixture: scenario.fixture,
      runId,
      threadId: runId,
      metadata: {},
    };
    const nodes = scriptedNodes(input);
    const investigationGraph = graph.createInvestigationGraph({ nodes });
    const result = await investigationGraph.execute({
      kind: 'start',
      state: initialStateFor(input),
    });
    results.push({
      scenarioId: scenario.id,
      evidence: [...result.evidence].sort(byId),
      trials: [...result.trials].sort(byId),
    });
  }
  return createHash('sha256')
    .update(JSON.stringify(domain.canonicalJson(results)))
    .digest('hex');
}

/**
 * One planned test per fixture entry, using the entry's own `toolId`/`input`
 * — an EXACT match for `createPlannedReplayExecutor`, so every recorded `ok`
 * entry is replayed verbatim through `ingestEvidence`'s `ok` branch. This
 * calls `execute_investigation` directly (bypassing `plan_investigation` and
 * every reasoning role, exactly as `investigation-plan-execute-wiring.test.mjs`
 * › "scriptedNodes(record) executes only planned tests..." already does for
 * one scenario), so it is model-free and deterministic the same way the sweep
 * above is.
 */
async function hashPlannedReplaySweep() {
  const results = [];
  let totalEvidence = 0;
  for (const scenario of evals.REPLAY_SCENARIOS) {
    const runId = `lane-arms-golden-sweep-${scenario.id}`;
    const input = {
      experimentId: 'aic146-b2-golden-sweep',
      exampleId: `${scenario.id}-golden-sweep`,
      scenarioId: scenario.id,
      fixture: scenario.fixture,
      runId,
      threadId: runId,
      metadata: {},
    };
    const nodes = scriptedNodes(input);
    const tests = scenario.fixture.entries.map((entry, index) => ({
      id: `${runId}-sweep-${index}`,
      predictionId: 'golden-sweep',
      tool: entry.toolId,
      input: entry.input,
      cost: 'cheap',
      status: 'planned',
    }));
    const { control } = initialStateFor(input);
    const executed = await nodes.execute_investigation({
      tests,
      trials: [],
      evidence: [],
      control,
    });
    totalEvidence += executed.evidence.length;
    results.push({
      scenarioId: scenario.id,
      evidence: [...executed.evidence].sort(byId),
      trials: [...executed.trials].sort(byId),
    });
  }
  const hash = createHash('sha256').update(JSON.stringify(domain.canonicalJson(results))).digest('hex');
  return { hash, totalEvidence };
}

test('the deterministic graph arm over every REPLAY_SCENARIOS entry hashes identically across two sweeps in the same process', async () => {
  const first = await hashDeterministicSweep();
  const second = await hashDeterministicSweep();
  assert.equal(first, second, 'the sweep must be reproducible before it is compared against a frozen constant');
});

test('the deterministic graph arm over every REPLAY_SCENARIOS entry produces exactly the evidence and trials this golden hash was captured from at f10ab64 (AIC-146 b1)', async () => {
  const actual = await hashDeterministicSweep();
  assert.equal(
    actual,
    GOLDEN_SHA256,
    'the deterministic graph arm\'s evidence and trials moved for at least one replay scenario',
  );
});

/**
 * Non-vacuity floor: this sweep exists specifically to reach `ingestEvidence`'s
 * `ok` branch, the one AIC-146 b2 changes. If this ever drops to zero, the
 * sweep has stopped measuring what it claims to and the golden hash below is
 * as vacuous, for evidence, as `hashDeterministicSweep`'s already is.
 */
test('the planned-replay sweep (one test per fixture entry) records a non-zero amount of evidence across REPLAY_SCENARIOS', async () => {
  const { totalEvidence } = await hashPlannedReplaySweep();
  assert.ok(
    totalEvidence > 0,
    `expected at least one evidence item across every scenario's exact-match planned tests, got ${totalEvidence}`,
  );
});

test('the planned-replay sweep hashes identically across two sweeps in the same process', async () => {
  const first = await hashPlannedReplaySweep();
  const second = await hashPlannedReplaySweep();
  assert.equal(
    first.hash,
    second.hash,
    'the planned-replay sweep must be reproducible before it is compared against a frozen constant',
  );
});

test('the planned-replay sweep over every REPLAY_SCENARIOS entry produces exactly the evidence and trials this golden hash was captured from at f10ab64 (AIC-146 b1)', async () => {
  const { hash } = await hashPlannedReplaySweep();
  assert.equal(
    hash,
    PLANNED_SWEEP_GOLDEN_SHA256,
    'the planned-replay sweep\'s evidence and trials moved for at least one replay scenario',
  );
});
