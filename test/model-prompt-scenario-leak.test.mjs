/**
 * AIC-114 (v0.2 evidence repair, slice 0d): the scenario id leaks into model
 * prompts.
 *
 * `initialBenchmarkState` (`packages/evals/src/benchmark-evaluation.ts`) sets
 * `incident: { id: input.scenarioId, ... }`, and every model role's prompt
 * (`packages/roles/src/investigation-roles.ts`, `describeState`) serializes
 * `incident` into the request it sends. So a live model reads labels straight
 * out of `REPLAY_SCENARIOS` — `bad-deployment`, `false-alert`, and the rest —
 * which is the ground truth this benchmark exists to keep from the thing it is
 * grading. This file pins the leak and the shape of the fix: the incident id a
 * node receives must be an opaque derivation of the run, never the scenario.
 *
 * 🔴 **Nothing in this file calls a real model, provider, or network.** Every
 * row drives the graph with a hand-written fake `ModelPort` that answers a
 * scripted, schema-valid document for whichever role asked (told apart by
 * `request.outputSchema`), which is exactly why the first test below can
 * afford to run EVERY scenario in `REPLAY_SCENARIOS`: no model anywhere ever
 * sees any of them, so there is no cost and no credential to running the full
 * set rather than a sample.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as evals from '@aic/evals';
import * as roles from '@aic/roles';
import { createModelNaiveInvestigation } from '@aic/roles';

import { modelNodes, scriptedNodes } from '../scripts/eval-live-model.mjs';
import { benchmarkVersions } from './fixtures/benchmark-experiment.mjs';

const MODEL_BACKED_ROLES = Object.freeze([
  'generate_hypotheses',
  'interpret_residual_evidence',
  'challenge_hypothesis',
]);

const ALL_SCENARIO_IDS = evals.REPLAY_SCENARIOS.map(({ id }) => id);

function requireEvalsExport(name) {
  assert.ok(evals[name] !== undefined, `@aic/evals must export ${name}`);
  return evals[name];
}

function requireRolesExport(name) {
  assert.ok(roles[name] !== undefined, `@aic/roles must export ${name}`);
  return roles[name];
}

/**
 * `createBenchmarkPlan` (and so `runGraphBenchmarkExperiment` with
 * `scenarioSet: 'ad-hoc'`) refuses anything other than exactly five scenarios
 * — see `createBenchmarkPlan` in `packages/evals/src/benchmark-evaluation.ts`.
 * `REPLAY_SCENARIOS` carries more than five, so this batches every scenario
 * into groups of five, padding the final group by repeating earlier scenarios
 * rather than inventing a sixth fixture. Padding only ever means "this
 * scenario runs an extra time"; it never drops a scenario from the sweep.
 */
function scenarioBatchesOfFive() {
  const scenarios = evals.REPLAY_SCENARIOS;
  const batches = [];
  for (let start = 0; start < scenarios.length; start += 5) {
    const batch = scenarios.slice(start, start + 5);
    for (let index = 0; batch.length < 5; index += 1) {
      batch.push(scenarios[index % scenarios.length]);
    }
    batches.push(batch);
  }
  return batches;
}

/** Tell the three model-backed roles apart by the answer shape they declared. */
function roleFromOutputSchema(outputSchema) {
  const keys = new Set(Object.keys(outputSchema?.properties ?? {}));
  if (keys.has('hypotheses')) return 'generate_hypotheses';
  if (keys.has('assessments')) return 'interpret_residual_evidence';
  if (keys.has('alternative') && keys.has('discriminatingTests')) {
    return 'challenge_hypothesis';
  }
  throw new Error(
    `fake port cannot classify a request from its outputSchema keys: ${[...keys].join(', ')}`,
  );
}

/**
 * A fake `ModelPort` that records every request it was asked (`system` AND
 * `prompt`, per `ModelCompletionRequest`, `packages/roles/src/reference-model-port.ts`)
 * and answers a document that satisfies the domain schema each role parses
 * with — enough for the graph to run generate_hypotheses,
 * interpret_residual_evidence (twice: once before the mandatory challenge
 * round and once after) and challenge_hypothesis to completion, never enough
 * to make a claim about model quality.
 */
function createFakeModelPort() {
  const captured = [];
  let counter = 0;

  function portFor({ runId, scenarioId }) {
    return {
      async complete(request) {
        const role = roleFromOutputSchema(request.outputSchema);
        counter += 1;
        captured.push({
          role,
          runId,
          scenarioId,
          system: request.system,
          prompt: request.prompt,
        });

        let document;
        if (role === 'generate_hypotheses') {
          document = {
            hypotheses: [
              { id: `fake-hypothesis-${counter}`, statement: 'a fake candidate cause' },
            ],
          };
        } else if (role === 'interpret_residual_evidence') {
          document = { assessments: [] };
        } else {
          document = {
            alternative: {
              id: `fake-alternative-${counter}`,
              statement: 'a fake alternative cause',
            },
            discriminatingTests: [
              {
                id: `fake-test-${counter}`,
                predictionId: `fake-prediction-${counter}`,
                tool: 'metrics',
                input: {},
                cost: 'cheap',
                status: 'planned',
              },
            ],
          };
        }

        return {
          text: JSON.stringify(document),
          modelId: 'fake-model-under-test',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
  }

  return { portFor, captured };
}

test('shows no REPLAY_SCENARIOS id in any model prompt, for every scenario and every model-backed role', async () => {
  const runGraphBenchmarkExperiment = requireEvalsExport('runGraphBenchmarkExperiment');
  const { portFor, captured } = createFakeModelPort();

  for (const scenarios of scenarioBatchesOfFive()) {
    await runGraphBenchmarkExperiment({
      experimentId: 'aic-114-scenario-leak-probe',
      scenarioSet: 'ad-hoc',
      scenarios,
      runsPerScenario: 3,
      metadata: benchmarkVersions,
      createNodes: (record) =>
        modelNodes(record, portFor({ runId: record.runId, scenarioId: record.scenarioId })),
      async recordEvaluation() {},
    });
  }

  assert.ok(captured.length > 0, 'expected at least one model request, or nothing was exercised');

  // Every role must have been reached ON EVERY RUN, so this test cannot pass by
  // capturing one role once and never exercising the other two.
  const rolesByRun = new Map();
  for (const entry of captured) {
    const roles = rolesByRun.get(entry.runId) ?? new Set();
    roles.add(entry.role);
    rolesByRun.set(entry.runId, roles);
  }
  assert.ok(rolesByRun.size > 0, 'expected at least one investigated run');
  for (const [runId, roles] of rolesByRun) {
    for (const role of MODEL_BACKED_ROLES) {
      assert.ok(
        roles.has(role),
        `run ${runId} never reached model-backed role ${role}, so this test could pass without exercising it`,
      );
    }
  }

  for (const entry of captured) {
    for (const scenarioId of ALL_SCENARIO_IDS) {
      const leaksInSystem = entry.system.includes(scenarioId);
      const leaksInPrompt = entry.prompt.includes(scenarioId);
      assert.equal(
        leaksInSystem || leaksInPrompt,
        false,
        `role ${entry.role} (run ${entry.runId}, scenario ${entry.scenarioId}) was shown REPLAY_SCENARIOS id "${scenarioId}" in its ${leaksInSystem ? 'system' : 'prompt'} text`,
      );
    }
  }
});

test('derives the incident id shown to the model from runId, not from the scenario', async () => {
  const opaqueIncidentId = requireEvalsExport('opaqueIncidentId');
  const runGraphBenchmarkExperiment = requireEvalsExport('runGraphBenchmarkExperiment');

  const runIdA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const runIdB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  assert.equal(
    opaqueIncidentId(runIdA),
    opaqueIncidentId(runIdA),
    'must be deterministic: the same runId derives the same incident id twice',
  );
  assert.notEqual(
    opaqueIncidentId(runIdA),
    opaqueIncidentId(runIdB),
    'two different runIds must derive two different incident ids',
  );
  assert.equal(
    opaqueIncidentId(runIdA).includes(runIdA),
    false,
    'the derived id must not embed the runId verbatim',
  );
  for (const scenarioId of ALL_SCENARIO_IDS) {
    assert.equal(
      opaqueIncidentId(runIdA).includes(scenarioId),
      false,
      `the derived id must not embed a REPLAY_SCENARIOS id (checked: ${scenarioId})`,
    );
  }

  // Now capture the id a real graph node actually receives, and require it to
  // be exactly this function's answer for that run's own runId — not an
  // independent claim about the function in isolation.
  const scenarios = evals.REPLAY_SCENARIOS.slice(0, 5);
  let observed;
  await runGraphBenchmarkExperiment({
    experimentId: 'aic-114-opaque-incident-id-probe',
    scenarioSet: 'ad-hoc',
    scenarios,
    runsPerScenario: 3,
    metadata: benchmarkVersions,
    createNodes: (record) => {
      const nodes = scriptedNodes(record);
      return {
        ...nodes,
        async normalize_incident(state) {
          if (observed === undefined) {
            observed = { runId: record.runId, incidentId: state.incident.id };
          }
          return nodes.normalize_incident(state);
        },
      };
    },
    async recordEvaluation() {},
  });

  assert.ok(
    observed !== undefined,
    'expected at least one run to reach normalize_incident with an observable incident id',
  );
  assert.equal(
    observed.incidentId,
    opaqueIncidentId(observed.runId),
    'the incident id a graph node receives must be exactly opaqueIncidentId(runId)',
  );
});

test('keeps scenarioId as evaluation metadata', () => {
  const createBenchmarkPlan = requireEvalsExport('createBenchmarkPlan');
  const scenarios = evals.REPLAY_SCENARIOS.slice(0, 5);

  const records = createBenchmarkPlan({
    experimentId: 'aic-114-metadata-guard',
    scenarios,
    runsPerScenario: 3,
    metadata: benchmarkVersions,
  });

  assert.equal(records.length, 15);
  for (const record of records) {
    assert.equal(
      record.metadata.scenarioId,
      record.scenario.id,
      'the fix must stop showing scenarioId to the model, not stop recording it as evaluation metadata',
    );
  }
});

/**
 * The naive single-prompt role (AIC-115) reads the same fixture telemetry the
 * graph arm replays. This row maps each scenario's fixture into the role's
 * input HERE, independently of any runner, so the role is covered by the leak
 * sweep on its own: every scenario, a fake port, every system and user prompt
 * searched for every scenario id. A positive assertion that the opaque id IS in
 * the prompt keeps the sweep from passing because nothing was shown at all.
 */
test('shows no REPLAY_SCENARIOS id in the naive role prompt, for every scenario', async () => {
  const captured = [];
  const port = {
    async complete(request) {
      captured.push(request);
      return {
        text: JSON.stringify({
          hypotheses: [],
          assessments: [],
          conclusion: { kind: 'inconclusive', causes: [] },
          stopKind: 'stalled',
        }),
        modelId: 'fake',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const naive = createModelNaiveInvestigation({ port, mechanisms: ['m-one', 'm-two'] });

  for (const scenario of evals.REPLAY_SCENARIOS) {
    const incidentId = evals.opaqueIncidentId(`naive-leak-run-${scenario.id.length}-${captured.length}`);
    const entries = scenario.fixture.entries.map(({ toolId, input, result }) => {
      if (result.status === 'ok') return { status: 'ok', tool: toolId, input, evidence: result.output };
      return result.status === 'unavailable'
        ? { status: 'unavailable', tool: toolId, input, reason: result.reason }
        : { status: 'error', tool: toolId, input, message: result.message };
    });
    const before = captured.length;
    await naive({ incidentId, entries });
    assert.equal(captured.length, before + 1, `the naive role must make exactly one call for ${scenario.id}`);
    const request = captured[captured.length - 1];
    assert.ok(request.prompt.includes(incidentId), `the naive prompt must carry the opaque incident id for ${scenario.id}`);
    for (const scenarioId of ALL_SCENARIO_IDS) {
      for (const [field, text] of [['system', request.system], ['prompt', request.prompt]]) {
        assert.equal(
          text.includes(scenarioId),
          false,
          `the naive role's ${field} for scenario ${scenario.id} carries REPLAY_SCENARIOS id "${scenarioId}"`,
        );
      }
    }
  }
  assert.equal(captured.length, evals.REPLAY_SCENARIOS.length);
});

/**
 * AIC-116 (v0.2 evidence repair, slice 2): the same sweep, driven through the
 * BENCHMARK RUNNER rather than by hand-building `NaiveInvestigationInput`
 * above — `runNaiveBenchmarkExperiment` projects each execution input with
 * `naiveInputFor` before it ever reaches the role. This row pins only that no
 * REPLAY_SCENARIOS id reaches a prompt along that path. What the projection
 * itself carries is pinned elsewhere:
 * see naive-arm.test.mjs › "naiveInputFor carries no scenario id, ground truth or metadata anywhere in its result"
 * see naive-arm.test.mjs › "keeps scenario ground truth outside the naive investigation callback, over the calibration plan"
 */
test('shows no REPLAY_SCENARIOS id in any prompt when runNaiveBenchmarkExperiment drives the real naive role over a capturing fake port', async () => {
  const runNaiveBenchmarkExperiment = requireEvalsExport('runNaiveBenchmarkExperiment');
  const captured = [];
  const port = {
    async complete(request) {
      captured.push(request);
      return {
        text: JSON.stringify({
          hypotheses: [],
          assessments: [],
          conclusion: { kind: 'inconclusive', causes: [] },
          stopKind: 'stalled',
        }),
        modelId: 'fake-model-under-test',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const investigate = createModelNaiveInvestigation({ port, mechanisms: ['m-one', 'm-two'] });

  for (const scenarios of scenarioBatchesOfFive()) {
    await runNaiveBenchmarkExperiment({
      experimentId: 'aic-116-naive-scenario-leak-probe',
      scenarioSet: 'ad-hoc',
      scenarios,
      runsPerScenario: 3,
      metadata: { ...benchmarkVersions, evaluatorVersion: 'behavior-evaluators-v0.3' },
      investigate,
      async recordEvaluation() {},
    });
  }

  assert.ok(captured.length > 0, 'expected at least one naive role request, or nothing was exercised');

  for (const request of captured) {
    for (const scenarioId of ALL_SCENARIO_IDS) {
      for (const [field, text] of [['system', request.system], ['prompt', request.prompt]]) {
        assert.equal(
          text.includes(scenarioId),
          false,
          `runNaiveBenchmarkExperiment's naive role ${field} carried REPLAY_SCENARIOS id "${scenarioId}"`,
        );
      }
    }
    assert.match(
      request.prompt,
      /incident-[0-9a-f]{16}/,
      'the naive prompt driven by runNaiveBenchmarkExperiment must carry an opaque incident id',
    );
  }
});

/**
 * AIC-119 slice D: the fourth model role, `propose_conclusion`
 * (`createModelProposeConclusion`, `packages/roles/src/investigation-roles.ts`),
 * reads `describeState`, the exact prompt-building function the three
 * MODEL_BACKED_ROLES above already share — so it inherits the same leak
 * surface `describeState` has for `incident`. Wiring this role into
 * `scripts/eval-live-model.mjs`'s `modelNodes` (and so into the
 * `runGraphBenchmarkExperiment` sweep above) is AIC-119 slice E, out of scope
 * here; this row instead drives the role directly, the same standalone shape
 * "shows no REPLAY_SCENARIOS id in the naive role prompt, for every scenario"
 * above already uses for the naive role, over the SAME real fixture evidence
 * `REPLAY_SCENARIOS` carries — not hand-written evidence a scenario's own
 * fixture would never actually contain.
 */
test('shows no REPLAY_SCENARIOS id in the propose_conclusion prompt, for every scenario', async () => {
  const createModelProposeConclusion = requireRolesExport('createModelProposeConclusion');
  const captured = [];
  const port = {
    async complete(request) {
      captured.push(request);
      return {
        text: JSON.stringify({ kind: 'inconclusive', causes: [] }),
        modelId: 'fake-model-under-test',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const node = createModelProposeConclusion({ port, mechanisms: ['m-one', 'm-two'] });

  for (const scenario of evals.REPLAY_SCENARIOS) {
    const okEntry = scenario.fixture.entries.find((entry) => entry.result.status === 'ok');
    const evidence = okEntry ? [...okEntry.result.output] : [];
    const opaqueIncidentId = evals.opaqueIncidentId(
      `conclusion-leak-run-${scenario.id.length}-${captured.length}`,
    );
    const state = {
      incident: { id: opaqueIncidentId },
      hypotheses: [
        { id: 'h-1', statement: 'a candidate cause drawn from the fixture', createdBy: 'initial' },
      ],
      predictions: [],
      tests: [],
      trials: [],
      evidence,
      assessments: [],
      control: { stopKind: 'sufficient', challengeRounds: 0 },
    };

    const before = captured.length;
    await node(state);
    assert.equal(
      captured.length,
      before + 1,
      `propose_conclusion must make exactly one call for ${scenario.id}`,
    );
    const request = captured[captured.length - 1];
    assert.ok(
      request.prompt.includes(opaqueIncidentId),
      `the propose_conclusion prompt must carry the opaque incident id for ${scenario.id}`,
    );
    for (const scenarioId of ALL_SCENARIO_IDS) {
      for (const [field, text] of [['system', request.system], ['prompt', request.prompt]]) {
        assert.equal(
          text.includes(scenarioId),
          false,
          `propose_conclusion's ${field} for scenario ${scenario.id} carries REPLAY_SCENARIOS id "${scenarioId}"`,
        );
      }
    }
  }

  assert.equal(captured.length, evals.REPLAY_SCENARIOS.length);
});
