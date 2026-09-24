/**
 * AIC-56 slice D2: the MODEL half of the acceptance row slice D1 already
 * proves for the TOOL half - "Kill between result transaction and LangGraph
 * checkpoint -> replay returns the exact committed result and does not call
 * LLM/tool twice" - applied to the three model-backed investigation roles
 * (`createModelGenerateHypotheses`, `createModelInterpretResidualEvidence`,
 * `createModelChallengeHypothesis`).
 *
 * Intended design (not yet implemented - this file is RED against current
 * code): `ModelRoleOptions` gains an optional `execution?: CommittedExecution`
 * (`@aic/domain`). With it, each role wraps ONLY `port.complete(request)` in
 *
 *   execution.committed(
 *     buildExecKey('model.role', {
 *       runId: state.control.runId,
 *       role,
 *       promptVersion,
 *       iterationsUsed: state.control.iterationsUsed,
 *       challengeRounds: state.control.challengeRounds,
 *       resumeCount: state.control.resumeCount,
 *     }),
 *     () => port.complete(request),
 *     { inputFingerprint },
 *   )
 *
 * where `inputFingerprint` is `sha256:` + hex sha256 of
 * `JSON.stringify(canonicalJson(request))`. Parsing of the completion stays
 * AFTER the commit, unchanged. Without `execution`, behaviour is
 * byte-identical to today (row 4).
 *
 * The in-memory `CommittedExecution` stand-in is slice D1's own fixture,
 * `test/fixtures/fake-committed-execution.mjs` - reused rather than copied
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation").
 *
 * The REAL-PostgreSQL half of this acceptance is
 * `infra/postgres/tests/durable-model-replay.live.mjs`.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { INCIDENT_STATE_SCHEMA_VERSION, STATUS_RULES_VERSION } from '@aic/domain';
import * as domain from '@aic/domain';
import { createInvestigationGraph } from '@aic/graph';
import * as persistence from '@aic/persistence';
import * as roles from '@aic/roles';

import { createFakeCommittedExecution } from './fixtures/fake-committed-execution.mjs';
import { scopedIncident } from './fixtures/scoped-incident.mjs';

/* -------------------------------------------------------------------------- */
/* Shared fixtures                                                            */
/* -------------------------------------------------------------------------- */

const initialState = () => ({
  incident: scopedIncident('incident-durable-model-replay'),
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
    runId: 'run-durable-model-replay',
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

const at = () => '2026-01-01T01:00:00.000Z';

/** A `ModelCompletion` carrying a scripted JSON document as its `text`. */
function jsonCompletion(document) {
  return {
    text: JSON.stringify(document),
    modelId: 'claude-under-test',
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

/**
 * A port that always answers the same completion and counts how many times
 * (and with what request) it was actually called - the independent oracle
 * every row below reads "was the model called" from, rather than from
 * anything the execution port itself claims.
 */
function countingPort(completion) {
  const requests = [];
  let callCount = 0;
  return {
    requests,
    get calls() {
      return callCount;
    },
    async complete(request) {
      callCount += 1;
      requests.push(request);
      return completion;
    },
  };
}

/** `sha256:` + hex sha256 of the canonical JSON of `value` - an independent copy of the intended design's own recipe, not an import of it. */
function expectedFingerprint(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(domain.canonicalJson(value))).digest('hex')}`;
}

/**
 * One entry per model role: how to build it, a state it can run against, how
 * to invoke it (the challenge role also takes a leaderId), and a scripted
 * completion it can be driven with.
 *
 * `roleName` is written as a literal, checked against
 * `packages/roles/src/investigation-roles.ts`'s own `role` constants, rather
 * than read back off anything the role exports - see the second row below.
 */
const ROLE_CASES = [
  {
    roleName: 'generate_hypotheses',
    create: (options) => roles.createModelGenerateHypotheses(options),
    buildState: () => initialState(),
    call: (node, state) => node(state),
    completion: jsonCompletion({
      hypotheses: [{ id: 'h-1', statement: 'the checkout deploy changed the db endpoint' }],
    }),
  },
  {
    roleName: 'interpret_residual_evidence',
    create: (options) => roles.createModelInterpretResidualEvidence(options),
    buildState: () => initialState(),
    call: (node, state) => node(state),
    completion: jsonCompletion({ assessments: [] }),
  },
  {
    roleName: 'challenge_hypothesis',
    create: (options) => roles.createModelChallengeHypothesis(options),
    buildState: () => {
      const state = initialState();
      state.hypotheses = [
        { id: 'h-1', statement: 'the checkout deploy did it', createdBy: 'initial' },
      ];
      return state;
    },
    call: (node, state) => node(state, 'h-1'),
    completion: jsonCompletion({
      alternative: { id: 'alt-1', statement: 'the dependency upgrade, not the deploy' },
      discriminatingTests: [
        { id: 'dt-1', predictionId: 'p-1', tool: 'logs.search', input: {}, cost: 'cheap' },
      ],
    }),
  },
];

/* -------------------------------------------------------------------------- */
/* Row 1 - crash between commit and checkpoint: replay reuses the committed   */
/* result and never calls the model a second time                            */
/* -------------------------------------------------------------------------- */

for (const roleCase of ROLE_CASES) {
  test(`${roleCase.roleName}: crash between commit and checkpoint - replay reuses the committed result and calls the model exactly once in total`, async () => {
    const port = countingPort(roleCase.completion);
    const fake = createFakeCommittedExecution({ crashAfterFirstCommit: true });
    const node = roleCase.create({ port, execution: fake, at });
    const state = roleCase.buildState();

    await assert.rejects(
      () => roleCase.call(node, state),
      /SIMULATED_CRASH_AFTER_COMMIT/,
      "the fixture must simulate the crash: the first commit lands durably before the sentinel propagates, exactly as slice D1's tool.trial row does",
    );

    const replayed = await roleCase.call(node, state);

    assert.equal(
      port.calls,
      1,
      `${roleCase.roleName} must call port.complete exactly once in TOTAL across the crash and the replay: replay must reuse the committed completion, never re-ask the model`,
    );

    // Independent oracle: a role instance with NO execution port at all, given
    // the exact same scripted completion, must produce the exact same node
    // result the replay produced - proving the replayed value is not merely
    // "a" result but byte-identical to what parsing that completion produces.
    const oracleNode = roleCase.create({ port: countingPort(roleCase.completion), at });
    const oracleResult = await roleCase.call(oracleNode, roleCase.buildState());

    assert.deepEqual(
      replayed,
      oracleResult,
      `${roleCase.roleName}'s replayed result must deep-equal the result a role WITHOUT execution produces from the identical completion`,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Row 2 - the exec key a role commits under                                  */
/* -------------------------------------------------------------------------- */

for (const roleCase of ROLE_CASES) {
  test(`${roleCase.roleName}: commits under buildExecKey('model.role', ...) built from the state's control fields, the role's own name and the prompt version in use`, async () => {
    const port = countingPort(roleCase.completion);
    const fake = createFakeCommittedExecution();
    const node = roleCase.create({ port, execution: fake });
    const state = roleCase.buildState();

    await roleCase.call(node, state);

    const expectedKey = domain.buildExecKey('model.role', {
      runId: state.control.runId,
      role: roleCase.roleName,
      promptVersion: roles.REFERENCE_PROMPT_VERSION,
      iterationsUsed: state.control.iterationsUsed,
      challengeRounds: state.control.challengeRounds,
      resumeCount: state.control.resumeCount,
    });

    assert.deepEqual(
      fake.calls,
      [expectedKey],
      `${roleCase.roleName} must call execution.committed with exactly the documented model.role exec key, and only once`,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Row 3 - the inputFingerprint a role sends                                  */
/* -------------------------------------------------------------------------- */

for (const roleCase of ROLE_CASES) {
  test(`${roleCase.roleName}: sends an inputFingerprint equal to sha256: plus the sha256 of the canonical JSON of the request the port received`, async () => {
    const port = countingPort(roleCase.completion);
    const optionsCalls = [];
    const execution = {
      async committed(execKey, compute, options = {}) {
        optionsCalls.push(options);
        return compute();
      },
    };
    const node = roleCase.create({ port, execution });
    const state = roleCase.buildState();

    await roleCase.call(node, state);

    assert.equal(port.requests.length, 1, 'the role must send exactly one request to the port');
    const [request] = port.requests;

    assert.equal(optionsCalls.length, 1, 'execution.committed must be called exactly once');
    assert.equal(
      optionsCalls[0].inputFingerprint,
      expectedFingerprint(request),
      `${roleCase.roleName} must send an inputFingerprint computed independently from the exact request object the port received`,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Row 4 - pass-through equivalence: an execution port that only calls        */
/* compute() through changes nothing observable                              */
/* -------------------------------------------------------------------------- */

for (const roleCase of ROLE_CASES) {
  test(`${roleCase.roleName}: a pass-through execution port produces the same node result as no execution port at all`, async () => {
    const passthrough = { committed: (_execKey, compute) => compute() };

    const nodeWithExecution = roleCase.create({
      port: countingPort(roleCase.completion),
      execution: passthrough,
      at,
    });
    const nodeWithoutExecution = roleCase.create({
      port: countingPort(roleCase.completion),
      at,
    });

    const withExecution = await roleCase.call(nodeWithExecution, roleCase.buildState());
    const withoutExecution = await roleCase.call(nodeWithoutExecution, roleCase.buildState());

    assert.deepEqual(
      withExecution,
      withoutExecution,
      `${roleCase.roleName}: an execution port that only calls compute() through must be byte-for-byte the same result as no execution port at all`,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Row 5 - key distinctness across a whole run: generate -> interpret ->      */
/* challenge -> interpret again, no exec key ever repeats                     */
/* -------------------------------------------------------------------------- */

/**
 * No existing harness in this repository drives all three model roles through
 * `createInvestigationGraph` far enough to reach a SECOND
 * `interpret_residual_evidence` after a challenge round in one offline
 * (no-network) test:
 *
 *   - `test/roles-model-nodes.test.mjs` › "routes a model-backed run to its
 *     challenge, with the leader the graph can see" stops at the first
 *     challenge and never loops back through `interpret_residual_evidence`.
 *   - `scripts/eval-live-model.mjs`'s `modelNodes` drives all three roles
 *     together, but only through `evals.runGraphBenchmarkExperiment` against
 *     the replay-fixture corpus (`test/fixtures/benchmark-experiment.mjs`),
 *     which is a real-tool-replay harness this row has no need of.
 *
 * So this row is the smallest one: every lifecycle node the three model roles
 * do not own is a no-op stub (the same pattern
 * `test/roles-model-nodes.test.mjs` already uses), and `termination_check` is
 * scripted to ask for exactly one challenge round before terminating - which
 * is enough to route the graph through
 * generate_hypotheses -> interpret_residual_evidence -> challenge_hypothesis
 *   -> interpret_residual_evidence -> terminal,
 * driven entirely by the edges `packages/graph/src/investigation.ts` already
 * declares (`challenge_hypothesis` -> `execute_investigation` -> ... ->
 * `interpret_residual_evidence` -> `derive_hypothesis_state` ->
 * `termination_check`).
 */
const LIFECYCLE_NODES = [
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

function createRecordingExecution() {
  const keys = [];
  return {
    keys,
    async committed(execKey, compute) {
      keys.push(execKey);
      return compute();
    },
  };
}

test('records a distinct model.role exec key for every model call across generate -> interpret -> challenge -> interpret, and no key ever repeats', async () => {
  const answers = [
    jsonCompletion({ hypotheses: [{ id: 'h-1', statement: 'the checkout deploy changed the db endpoint' }] }),
    jsonCompletion({ assessments: [] }),
    jsonCompletion({
      alternative: { id: 'alt-1', statement: 'the dependency upgrade, not the deploy' },
      discriminatingTests: [
        { id: 'dt-1', predictionId: 'p-1', tool: 'logs.search', input: {}, cost: 'cheap' },
      ],
    }),
    jsonCompletion({ assessments: [] }),
  ];
  const remaining = [...answers];
  let portCalls = 0;
  const port = {
    async complete() {
      portCalls += 1;
      const next = remaining.shift();
      assert.ok(next !== undefined, 'the scripted port ran out of answers: the scenario below asked for a fifth model call');
      return next;
    },
  };
  const recording = createRecordingExecution();

  const nodes = Object.fromEntries(LIFECYCLE_NODES.map((name) => [name, async () => ({})]));
  nodes.generate_hypotheses = roles.createModelGenerateHypotheses({ port, execution: recording, at });
  nodes.interpret_residual_evidence = roles.createModelInterpretResidualEvidence({
    port,
    execution: recording,
    at,
  });
  nodes.challenge_hypothesis = roles.createModelChallengeHypothesis({ port, execution: recording, at });

  let terminationCalls = 0;
  nodes.termination_check = async (state) => {
    terminationCalls += 1;
    if (terminationCalls === 1) {
      return { route: 'challenge-required', leaderId: state.hypotheses[0]?.id };
    }
    return { route: 'terminal', stopKind: 'sufficient' };
  };

  const graph = createInvestigationGraph({ nodes });
  await graph.execute({ kind: 'start', state: initialState() });

  assert.equal(
    portCalls,
    4,
    'the scenario must reach exactly four model calls: generate, interpret (round 1), challenge, interpret (round 2)',
  );
  assert.equal(
    recording.keys.length,
    portCalls,
    'the counting port is the independent oracle: one exec key must be recorded per model call, no more and no fewer',
  );
  assert.equal(
    new Set(recording.keys).size,
    recording.keys.length,
    'no model.role exec key may repeat across the run: a repeat would mean two different model calls sharing one committed slot',
  );
});

/* -------------------------------------------------------------------------- */
/* The checkpoint boundary: a replay's state comes back through the serde     */
/* -------------------------------------------------------------------------- */

/**
 * A resumed run hands a role the state the checkpointer restored, not the
 * object the crashed call saw. The exec key and the inputFingerprint are both
 * recomputed from it, and the fingerprint hashes a prompt that is already a
 * serialized string — so if the restored state ever serialized differently,
 * every legitimate replay would be refused as an integrity violation, and by
 * decision 6 refused again on every retry. This row crosses that boundary
 * through both checkpointers this repository builds.
 */
for (const roleCase of ROLE_CASES) {
  test(`${roleCase.roleName}: the exec key and inputFingerprint survive the state's round trip through the checkpointer serde`, async () => {
    const seen = [];
    const recording = {
      async committed(execKey, compute, options) {
        seen.push({ execKey, inputFingerprint: options?.inputFingerprint });
        return compute();
      },
    };
    const node = roleCase.create({ port: countingPort(roleCase.completion), execution: recording });
    const state = roleCase.buildState();
    await roleCase.call(node, state);

    const sqlite = persistence.createSqliteCheckpointer(':memory:');
    const postgres = persistence.createPostgresCheckpointer('postgresql://aic@127.0.0.1:1/never-connected');
    try {
      for (const [name, saver] of [
        ['sqlite', sqlite],
        ['postgres', postgres],
      ]) {
        const [type, bytes] = await saver.serde.dumpsTyped(state);
        const restored = await saver.serde.loadsTyped(type, bytes);
        assert.notEqual(restored, state, 'the round trip must hand the role a new object, not the original');
        await roleCase.call(node, restored);
        assert.deepEqual(
          seen.at(-1),
          seen[0],
          `${roleCase.roleName}: a state restored by the ${name} checkpointer's serde must yield the same exec key and inputFingerprint as the state the original call saw`,
        );
      }
      assert.equal(seen.length, 3, 'the role must have been called on the original state and on both restored copies');
    } finally {
      await postgres.pool?.end?.();
    }
  });
}
