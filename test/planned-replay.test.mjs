/**
 * AIC-125 slice c: `createPlannedReplayExecutor`, the replay port a planned
 * (`plan_investigation`, slice a) request answers through when the frozen
 * corpus records no call whose OWN input equals the request. A vocabulary
 * request such as `{ service: 'payments', window: 'pre-onset' }` (`routes`,
 * `@aic/graph`'s `INVESTIGATION_ROUTES`) names a quantity the corpus never
 * queried directly, but a recorded call for a DIFFERENT window on the same
 * tool may still carry, in its own `OBSERVATION_ANNOTATIONS` fact, the answer
 * to exactly that quantity. This port is the read side of that gap; it is not
 * wired into any lane here.
 *
 * `createPlannedReplayExecutor({ fixture, routes, annotate })` is exported
 * from `@aic/tools/replay`, not `@aic/evals` — `@aic/evals` must stay
 * independent of `@aic/tools` (test/replay-scenarios.test.mjs › "keeps
 * @aic/evals independent of @aic/tools", and the pinned evals dependency
 * list in test/benchmark-evaluation.test.mjs), while this port needs
 * `ReplayToolAdapter` and `createReplayFixtureKey`, both `@aic/tools`. It
 * returns `{ execute(context) }`, `context` being `{ runId, testId, attempt,
 * tool, input }` and the result a `ToolResult` (`@aic/tools`): `{ status:
 * 'ok', output: Evidence[] }` | `{ status: 'unavailable', reason }` | `{
 * status: 'error', message }`. `fixture` is a scenario's own replay fixture
 * shape (`{ version, entries: [{ toolId, input, result }] }` — structurally
 * `packages/evals/src/replay-scenarios.ts`'s `ScenarioReplayFixture`, never
 * imported as a type here, since tools must not import evals types), never
 * the `{ version, responses }` shape `ReplayToolAdapter`'s constructor takes
 * — the port needs each entry's own `(toolId, input)` to invert a route, and
 * `{ responses }` has already collapsed that. `annotate` is REQUIRED: a tool
 * cannot default to evals' own observation annotator, so every call below
 * passes one explicitly — `evals.createObservationAnnotator()` for a row
 * built from the frozen corpus, a test-local annotator for an ad-hoc row.
 * It is otherwise the same signature `ReplayToolAdapter`'s `{ observations }`
 * option takes: `(identity, evidence) => ObservedFact[] | undefined`.
 *
 * `replayFixtureFromScenarioEntries(fixture)`, the second export specified
 * here, converts that same scenario fixture shape into the
 * `ReplayToolAdapter` fixture shape (`{ version, responses }`, the version
 * carried through and `responses` keyed by `createReplayFixtureKey`) — the conversion
 * `test/fixtures/benchmark-experiment.mjs` carried as its own `replayFixtureFor`
 * before this slice (`git show origin/main:test/fixtures/benchmark-experiment.mjs`),
 * now owned by `@aic/tools/replay` instead of duplicated per caller
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation").
 *
 * The spy-annotator rows below treat a call's replay identity as opaque —
 * they never re-derive it (`.claude/rules/invariants.md`, "the
 * independent-oracle invariant" does not apply here: this is a behavioural
 * spec for domain logic, not a security/governance mechanism, so nothing
 * here needs a second, independent identity computation the way
 * `observation-merge.test.mjs`'s own `replayIdentity` does).
 *
 * The calibration-partition rows (`deployment-caused-incident-a`,
 * `bad-deployment`) pin literals measured directly off the frozen corpus by
 * running the real, already-implemented `derivePredictions` /
 * `planInvestigation` / `INVESTIGATION_ROUTES` / `OBSERVATION_ANNOTATIONS`
 * against the corpus (no stand-in), because this port does not exist yet to
 * measure against: `deployment-caused-incident-a`'s own `deployments` call
 * carries a fact whose window is `pre-onset` even though the call itself
 * queried `window: 'incident'` — the exact gap this port exists to close —
 * while `bad-deployment`'s two recorded calls carry no facts at all.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as graph from '@aic/graph';
import * as evals from '@aic/evals';
import { createReplayFixtureKey } from '@aic/tools';
import * as toolsReplay from '@aic/tools/replay';

const { ReplayToolAdapter } = toolsReplay;

function requireCreatePlannedReplayExecutor() {
  assert.equal(
    typeof toolsReplay.createPlannedReplayExecutor,
    'function',
    '@aic/tools/replay must export createPlannedReplayExecutor(options)',
  );
  return toolsReplay.createPlannedReplayExecutor;
}

function requireReplayFixtureFromScenarioEntries() {
  assert.equal(
    typeof toolsReplay.replayFixtureFromScenarioEntries,
    'function',
    '@aic/tools/replay must export replayFixtureFromScenarioEntries(fixture)',
  );
  return toolsReplay.replayFixtureFromScenarioEntries;
}

function scenario(id) {
  const found = evals.REPLAY_SCENARIOS.find((s) => s.id === id);
  assert.ok(found, `REPLAY_SCENARIOS must carry ${id}`);
  return found;
}

function adapterFixtureFor(scenarioFixture) {
  return {
    version: scenarioFixture.version,
    responses: Object.fromEntries(
      scenarioFixture.entries.map((entry) => [
        createReplayFixtureKey(entry.toolId, entry.input),
        entry.result,
      ]),
    ),
  };
}

function baseContext(overrides = {}) {
  return {
    runId: 'run-1',
    testId: 'test-1',
    attempt: 1,
    tool: 'deployments',
    input: { service: 'payments', window: 'incident' },
    ...overrides,
  };
}

function evidenceItem(id, statement, overrides = {}) {
  return {
    id,
    trialId: `trial-${id}`,
    kind: 'metric',
    source: `source/${id}`,
    observedAt: '2026-01-01T00:00:00.000Z',
    statement,
    rawRef: `replay://source/${id}`,
    ...overrides,
  };
}

function ok(...output) {
  return { status: 'ok', output };
}

/* ============================================================================
 * 1. EXACT recorded request
 * ==========================================================================*/

test('an EXACT recorded request answers exactly what ReplayToolAdapter with the observation annotator returns for it, evidence carrying observation where the table has facts', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();
  const { fixture } = scenario('deployment-caused-incident-a');
  const [deploymentEntry] = fixture.entries;
  assert.equal(deploymentEntry.toolId, 'deployments');
  assert.deepEqual(deploymentEntry.input, { service: 'payments', window: 'incident' });

  const executor = createPlannedReplayExecutor({
    fixture,
    routes: graph.INVESTIGATION_ROUTES,
    annotate: evals.createObservationAnnotator(),
  });

  const referenceAdapter = new ReplayToolAdapter(adapterFixtureFor(fixture), {
    observations: evals.createObservationAnnotator(),
  });
  const expected = await referenceAdapter.execute(deploymentEntry.toolId, deploymentEntry.input);
  assert.equal(expected.status, 'ok');
  assert.ok(expected.output[0].observation, 'sanity: the reference adapter must itself annotate this evidence');

  const result = await executor.execute(
    baseContext({ tool: deploymentEntry.toolId, input: deploymentEntry.input }),
  );

  assert.deepEqual(result, expected);
});

test('an EXACT recorded request matches by replay identity, not object key order: the same input with its keys reordered still counts as the exact recorded request', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();
  const { fixture } = scenario('deployment-caused-incident-a');
  const [deploymentEntry] = fixture.entries;

  const executor = createPlannedReplayExecutor({
    fixture,
    routes: graph.INVESTIGATION_ROUTES,
    annotate: evals.createObservationAnnotator(),
  });

  const reordered = { window: deploymentEntry.input.window, service: deploymentEntry.input.service };
  const inOrder = await executor.execute(
    baseContext({ tool: deploymentEntry.toolId, input: deploymentEntry.input }),
  );
  const outOfOrder = await executor.execute(
    baseContext({ tool: deploymentEntry.toolId, input: reordered }),
  );

  assert.deepEqual(outOfOrder, inOrder);
});

/* ============================================================================
 * 2. QUANTITY match
 * ==========================================================================*/

test('a QUANTITY match answers ok with the union of every same-tool recorded entry whose annotated fact matches the requested form, subject, window and discriminant, each evidence id once, in fixture order', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();

  const entries = [
    {
      toolId: 'metrics',
      input: { service: 'checkout', window: 'incident', metric: 'db-pool-probe' },
      result: ok(evidenceItem('metric-checkout-pool', 'checkout pool probe')),
    },
    {
      toolId: 'metrics',
      input: { service: 'payments', window: 'incident', metric: 'error-rate-probe-a' },
      result: ok(evidenceItem('metric-payments-a', 'payments error rate probe a')),
    },
    {
      toolId: 'metrics',
      input: { service: 'payments', window: 'incident', metric: 'error-rate-probe-b' },
      result: ok(evidenceItem('metric-payments-b', 'payments error rate probe b')),
    },
  ];
  const fixture = { version: 1, entries };

  const factsByEvidenceId = {
    'metric-checkout-pool': [
      { form: 'signal-state', subject: 'checkout', window: 'incident', signal: 'connection-pool', state: 'at-limit' },
    ],
    'metric-payments-a': [
      { form: 'signal-state', subject: 'payments', window: 'incident', signal: 'error-rate', state: 'elevated' },
    ],
    'metric-payments-b': [
      { form: 'signal-state', subject: 'payments', window: 'incident', signal: 'error-rate', state: 'elevated' },
    ],
  };
  const annotate = (_identity, evidence) => factsByEvidenceId[evidence.id];

  const executor = createPlannedReplayExecutor({ fixture, routes: graph.INVESTIGATION_ROUTES, annotate });

  const result = await executor.execute(
    baseContext({ tool: 'metrics', input: { service: 'payments', window: 'incident', metric: 'error-rate' } }),
  );

  assert.equal(result.status, 'ok');
  assert.deepEqual(
    result.output.map((item) => item.id),
    ['metric-payments-a', 'metric-payments-b'],
  );
  for (const item of result.output) {
    assert.deepEqual(item.observation, { version: domain.EXPECTED_OBSERVATION_VERSION, facts: factsByEvidenceId[item.id] });
  }
});

test('a QUANTITY match never inspects a recorded entry of a different tool: an entry of an unrelated tool is neither annotated nor returned, even when its own fact would otherwise match', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();

  const entries = [
    {
      toolId: 'metrics',
      input: { service: 'payments', window: 'incident', metric: 'error-rate-probe' },
      result: ok(evidenceItem('metric-payments-match', 'payments error rate probe')),
    },
    {
      toolId: 'deployments',
      input: { service: 'payments', window: 'incident' },
      result: ok(evidenceItem('deploy-payments-unrelated', 'unrelated deployment call')),
    },
  ];
  const fixture = { version: 1, entries };

  const factsByEvidenceId = {
    'metric-payments-match': [
      { form: 'signal-state', subject: 'payments', window: 'incident', signal: 'error-rate', state: 'elevated' },
    ],
    // If the port ever asked about this evidence item, it would answer a fact
    // shaped so it too would satisfy the request below — the request must
    // never reach it regardless, because it belongs to a different tool.
    'deploy-payments-unrelated': [
      { form: 'signal-state', subject: 'payments', window: 'incident', signal: 'error-rate', state: 'elevated' },
    ],
  };
  const annotatedEvidenceIds = [];
  const annotate = (_identity, evidence) => {
    annotatedEvidenceIds.push(evidence.id);
    return factsByEvidenceId[evidence.id];
  };

  const executor = createPlannedReplayExecutor({ fixture, routes: graph.INVESTIGATION_ROUTES, annotate });

  const result = await executor.execute(
    baseContext({ tool: 'metrics', input: { service: 'payments', window: 'incident', metric: 'error-rate' } }),
  );

  assert.equal(result.status, 'ok');
  assert.deepEqual(
    result.output.map((item) => item.id),
    ['metric-payments-match'],
  );
  assert.ok(
    !annotatedEvidenceIds.includes('deploy-payments-unrelated'),
    'must never annotate (and so never execute) an entry belonging to a different tool',
  );
});

test('a QUANTITY match is independent of outcome: a matching fact that contradicts what a hopeful template expected still answers ok with that fact', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();

  const entries = [
    {
      toolId: 'metrics',
      input: { service: 'payments', window: 'incident', metric: 'error-rate-probe' },
      result: ok(evidenceItem('metric-payments-normal', 'payments error rate probe')),
    },
  ];
  const fixture = { version: 1, entries };

  // A template expecting 'elevated' would read this as a refutation, not a
  // confirmation — the port answers the quantity, never the value.
  const contradictingFact = {
    form: 'signal-state',
    subject: 'payments',
    window: 'incident',
    signal: 'error-rate',
    state: 'normal',
  };
  const annotate = (_identity, evidence) =>
    evidence.id === 'metric-payments-normal' ? [contradictingFact] : undefined;

  const executor = createPlannedReplayExecutor({ fixture, routes: graph.INVESTIGATION_ROUTES, annotate });

  const result = await executor.execute(
    baseContext({ tool: 'metrics', input: { service: 'payments', window: 'incident', metric: 'error-rate' } }),
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.output.length, 1);
  assert.deepEqual(result.output[0].observation, {
    version: domain.EXPECTED_OBSERVATION_VERSION,
    facts: [contradictingFact],
  });
});

test('a QUANTITY match compares the subject case- and whitespace-insensitively, matching normalizeSubject\'s own rule (trim + lowercase)', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();

  const entries = [
    {
      toolId: 'metrics',
      input: { service: 'Payments ', window: 'incident', metric: 'error-rate-probe' },
      result: ok(evidenceItem('metric-payments-padded', 'payments error rate probe, padded subject')),
    },
  ];
  const fixture = { version: 1, entries };

  const annotate = (_identity, evidence) =>
    evidence.id === 'metric-payments-padded'
      ? [{ form: 'signal-state', subject: '  PAYMENTS', window: 'incident', signal: 'error-rate', state: 'elevated' }]
      : undefined;

  const executor = createPlannedReplayExecutor({ fixture, routes: graph.INVESTIGATION_ROUTES, annotate });

  const result = await executor.execute(
    baseContext({ tool: 'metrics', input: { service: 'payments', window: 'incident', metric: 'error-rate' } }),
  );

  assert.equal(result.status, 'ok');
  assert.deepEqual(
    result.output.map((item) => item.id),
    ['metric-payments-padded'],
  );
});

/* ============================================================================
 * 3. No match at all -> unavailable
 * ==========================================================================*/

test('a QUANTITY match normalises the REQUEST subject by the same rule: a padded, upper-case service in the request still matches a clean fact subject', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();
  const fixture = {
    version: 1,
    entries: [
      {
        toolId: 'metrics',
        input: { service: 'payments', metric: 'error-rate-probe' },
        result: ok(evidenceItem('metric-payments-clean', 'payments error rate probe, clean subject')),
      },
    ],
  };
  const annotate = (_identity, evidence) =>
    evidence.id === 'metric-payments-clean'
      ? [{ form: 'signal-state', subject: 'payments', window: 'incident', signal: 'error-rate', state: 'elevated' }]
      : undefined;
  const executor = createPlannedReplayExecutor({ fixture, routes: graph.INVESTIGATION_ROUTES, annotate });

  const result = await executor.execute(
    baseContext({ tool: 'metrics', input: { service: '  PAYMENTS ', window: 'incident', metric: 'error-rate' } }),
  );

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output.map((item) => item.id), ['metric-payments-clean']);
});

test('a request whose tool names no entry in routes.byForm answers unavailable, never ok', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();
  const fixture = { version: 1, entries: [] };

  const executor = createPlannedReplayExecutor({
    fixture,
    routes: graph.INVESTIGATION_ROUTES,
    annotate: () => undefined,
  });

  // 'dependencies' is a registered read-only tool (READ_ONLY_TOOL_REGISTRY)
  // but INVESTIGATION_ROUTES routes no observation form to it.
  const result = await executor.execute(
    baseContext({ tool: 'dependencies', input: { service: 'payments', window: 'incident' } }),
  );

  assert.equal(result.status, 'unavailable');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

test('a request whose input keys are not exactly the routed form\'s input keys answers unavailable, never ok', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();
  const fixture = { version: 1, entries: [] };

  const executor = createPlannedReplayExecutor({
    fixture,
    routes: graph.INVESTIGATION_ROUTES,
    annotate: () => undefined,
  });

  // 'metrics' is routed (signal-state: service, window, metric); this input
  // carries every one of those plus an extra key the route names nothing for.
  const result = await executor.execute(
    baseContext({
      tool: 'metrics',
      input: { service: 'payments', window: 'incident', metric: 'error-rate', extra: 'unexpected' },
    }),
  );

  assert.equal(result.status, 'unavailable');
  assert.ok(result.reason.length > 0);
});

test('a request whose input is missing one of the routed form\'s input keys answers unavailable, never ok', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();
  const fixture = { version: 1, entries: [] };

  const executor = createPlannedReplayExecutor({
    fixture,
    routes: graph.INVESTIGATION_ROUTES,
    annotate: () => undefined,
  });

  const result = await executor.execute(
    baseContext({ tool: 'metrics', input: { service: 'payments', window: 'incident' } }),
  );

  assert.equal(result.status, 'unavailable');
  assert.ok(result.reason.length > 0);
});

test('a routed, well-formed request with no recorded entry of its tool at all answers unavailable, never ok-with-empty', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();
  const fixture = {
    version: 1,
    entries: [
      {
        toolId: 'deployments',
        input: { service: 'checkout', window: 'incident' },
        result: ok(evidenceItem('deploy-checkout-unrelated', 'unrelated deployment call')),
      },
    ],
  };

  const executor = createPlannedReplayExecutor({
    fixture,
    routes: graph.INVESTIGATION_ROUTES,
    annotate: () => undefined,
  });

  const result = await executor.execute(
    baseContext({ tool: 'logs', input: { service: 'checkout', window: 'incident', query: 'startup-errors' } }),
  );

  assert.equal(result.status, 'unavailable');
  assert.ok(result.reason.length > 0);
});

test('a routed, well-formed request whose same-tool recorded entries carry no matching fact answers unavailable, never ok-with-empty', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();
  const fixture = {
    version: 1,
    entries: [
      {
        toolId: 'metrics',
        input: { service: 'checkout', window: 'incident', metric: 'unrelated-probe' },
        result: ok(evidenceItem('metric-checkout-unrelated', 'unrelated metric call')),
      },
    ],
  };
  const annotate = (_identity, evidence) =>
    evidence.id === 'metric-checkout-unrelated'
      ? [{ form: 'signal-state', subject: 'checkout', window: 'incident', signal: 'connection-pool', state: 'at-limit' }]
      : undefined;

  const executor = createPlannedReplayExecutor({ fixture, routes: graph.INVESTIGATION_ROUTES, annotate });

  const result = await executor.execute(
    baseContext({ tool: 'metrics', input: { service: 'payments', window: 'incident', metric: 'error-rate' } }),
  );

  assert.equal(result.status, 'unavailable');
  assert.ok(result.reason.length > 0);
});

/* ============================================================================
 * 6. Unrelated entries are never executed (spy-wrapped adapter)
 * ==========================================================================*/

test('unrelated entries are never executed: a fixture carrying entries no request names is replayed for none of them, only the matched entry is replayed', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();

  const entries = [
    {
      toolId: 'deployments',
      input: { service: 'payments', window: 'incident' },
      result: ok(evidenceItem('confirmation-deploy-v17', 'payments-v17 completed five minutes before the first alert')),
    },
    {
      toolId: 'dependencies',
      input: { service: 'payments', window: 'incident' },
      result: ok(evidenceItem('payments-dependencies-healthy', 'payments dependencies stayed healthy during the incident window')),
    },
    {
      toolId: 'logs',
      input: { service: 'checkout', query: 'startup-errors' },
      result: ok(evidenceItem('checkout-invalid-database-endpoint', 'checkout rejected the database endpoint after checkout-v42')),
    },
  ];
  const fixture = { version: 1, entries };

  const annotatedEvidenceIds = [];
  const annotate = (_identity, evidence) => {
    annotatedEvidenceIds.push(evidence.id);
    return undefined;
  };

  const executor = createPlannedReplayExecutor({ fixture, routes: graph.INVESTIGATION_ROUTES, annotate });

  // Exact match on the first entry: the other two entries name different
  // tools and must never be replayed for this call.
  const result = await executor.execute(
    baseContext({ tool: 'deployments', input: { service: 'payments', window: 'incident' } }),
  );

  assert.equal(result.status, 'ok');
  assert.deepEqual(annotatedEvidenceIds, ['confirmation-deploy-v17']);
});

/* ============================================================================
 * 7. Never throws; malformed input is unavailable
 * ==========================================================================*/

for (const [label, malformedInput] of [
  ['null', null],
  ['a string', 'not-an-object'],
  ['a number', 42],
]) {
  test(`a malformed input (${label}, not an object) answers unavailable and the port does not throw`, async () => {
    const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();
    const fixture = { version: 1, entries: [] };
    const executor = createPlannedReplayExecutor({
      fixture,
      routes: graph.INVESTIGATION_ROUTES,
      annotate: () => undefined,
    });

    await assert.doesNotReject(async () => {
      const result = await executor.execute(
        baseContext({ tool: 'metrics', input: malformedInput }),
      );
      assert.equal(result.status, 'unavailable');
    });
  });
}

test('the port never throws for a well-formed but unroutable request', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();
  const fixture = { version: 1, entries: [] };
  const executor = createPlannedReplayExecutor({
    fixture,
    routes: graph.INVESTIGATION_ROUTES,
    annotate: () => undefined,
  });

  await assert.doesNotReject(async () => {
    await executor.execute(baseContext({ tool: 'traces', input: { anything: 'goes' } }));
  });
});

test('constructing without annotate throws a TypeError naming annotate: a tool port cannot default to evals\' own observation annotator', () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();
  const fixture = { version: 1, entries: [] };

  assert.throws(
    () => createPlannedReplayExecutor({ fixture, routes: graph.INVESTIGATION_ROUTES }),
    (error) => error instanceof TypeError && /annotate/.test(error.message),
  );
});

/* ============================================================================
 * 5. Calibration measurement rows (calibration partition ONLY)
 * ==========================================================================*/

function hypothesisWithCause(id, component, mechanism) {
  return { id, statement: `${id} statement`, createdBy: 'initial', cause: { component, mechanism } };
}

function plannedTestsFor(component) {
  const predictions = domain.derivePredictions({
    hypotheses: [hypothesisWithCause('h1', component, 'deployment-regression')],
    predictions: [],
    templates: graph.PREDICTION_TEMPLATES,
  });
  return domain.planInvestigation({ predictions, tests: [], routes: graph.INVESTIGATION_ROUTES });
}

test('deployment-caused-incident-a: planning from a deployment-regression hypothesis for payments produces exactly the deployment (pre-onset) and error-rate (incident) tests', () => {
  const planned = plannedTestsFor('payments');

  assert.equal(planned.length, 2);
  assert.deepEqual(
    planned.map(({ tool, input }) => ({ tool, input })),
    [
      { tool: 'deployments', input: { service: 'payments', window: 'pre-onset' } },
      { tool: 'metrics', input: { service: 'payments', window: 'incident', metric: 'error-rate' } },
    ],
  );
});

test('deployment-caused-incident-a: executing the planned deployment test through the port answers ok with the pre-onset deployment fact, measured off the frozen corpus (the call itself was recorded for window: incident)', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();
  const { fixture } = scenario('deployment-caused-incident-a');
  const [planned] = plannedTestsFor('payments');
  assert.equal(planned.tool, 'deployments');

  const executor = createPlannedReplayExecutor({
    fixture,
    routes: graph.INVESTIGATION_ROUTES,
    annotate: evals.createObservationAnnotator(),
  });
  const result = await executor.execute(
    baseContext({ tool: planned.tool, input: planned.input }),
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.output.length, 1);
  assert.equal(result.output[0].id, 'confirmation-deploy-v17');
  // Measured directly off OBSERVATION_ANNOTATIONS for this (identity, evidence
  // id) pair — the frozen corpus's own recorded fact, window pre-onset, even
  // though the recording call itself queried window: incident.
  assert.deepEqual(result.output[0].observation, {
    version: domain.EXPECTED_OBSERVATION_VERSION,
    facts: [{ form: 'deployment-in-window', subject: 'payments', window: 'pre-onset', count: 1, coverage: 'partial' }],
  });
});

test('deployment-caused-incident-a: executing the planned error-rate test through the port answers unavailable, measured off the frozen corpus (it carries no metrics call at all)', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();
  const { fixture } = scenario('deployment-caused-incident-a');
  const [, planned] = plannedTestsFor('payments');
  assert.equal(planned.tool, 'metrics');

  const executor = createPlannedReplayExecutor({
    fixture,
    routes: graph.INVESTIGATION_ROUTES,
    annotate: evals.createObservationAnnotator(),
  });
  const result = await executor.execute(
    baseContext({ tool: planned.tool, input: planned.input }),
  );

  assert.equal(result.status, 'unavailable');
});

test('bad-deployment: planning from a deployment-regression hypothesis for checkout, executed through the port, answers unavailable for every planned test, measured off the frozen corpus (both recorded calls carry no facts)', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();
  const { fixture } = scenario('bad-deployment');
  const planned = plannedTestsFor('checkout');
  assert.equal(planned.length, 2);

  const executor = createPlannedReplayExecutor({
    fixture,
    routes: graph.INVESTIGATION_ROUTES,
    annotate: evals.createObservationAnnotator(),
  });

  const results = await Promise.all(
    planned.map(({ tool, input }) => executor.execute(baseContext({ tool, input }))),
  );

  for (const result of results) {
    assert.equal(result.status, 'unavailable');
  }
});

/* ============================================================================
 * 8. replayFixtureFromScenarioEntries: scenario fixture -> ReplayToolAdapter fixture
 * ==========================================================================*/

test('replayFixtureFromScenarioEntries converts a calibration scenario\'s replay fixture into exactly the ReplayToolAdapter fixture test/fixtures/benchmark-experiment.mjs\'s own replayFixtureFor produced for it before this slice (git show origin/main:test/fixtures/benchmark-experiment.mjs)', () => {
  const replayFixtureFromScenarioEntries = requireReplayFixtureFromScenarioEntries();
  const { fixture } = scenario('deployment-caused-incident-a');

  const converted = replayFixtureFromScenarioEntries(fixture);

  assert.deepEqual(converted, adapterFixtureFor(fixture));
});

test('a ReplayToolAdapter built from replayFixtureFromScenarioEntries replays a recorded entry byte-identical to the scenario\'s own recorded result', async () => {
  const replayFixtureFromScenarioEntries = requireReplayFixtureFromScenarioEntries();
  const { fixture } = scenario('deployment-caused-incident-a');
  const [deploymentEntry] = fixture.entries;

  const adapter = new ReplayToolAdapter(replayFixtureFromScenarioEntries(fixture));
  const result = await adapter.execute(deploymentEntry.toolId, deploymentEntry.input);

  assert.deepEqual(result, deploymentEntry.result);
});

/* ============================================================================
 * 9. Review round 1: dedupe, ambiguous routes, fixture version, output shape,
 *    and the corpus row showing answerability does not track ground truth
 * ==========================================================================*/

test('a QUANTITY match answers an evidence id once when two matching same-tool entries both return it', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();
  const shared = evidenceItem('metric-payments-shared', 'payments error rate, shared');
  const fixture = {
    version: 1,
    entries: [
      { toolId: 'metrics', input: { service: 'payments', metric: 'probe-a' }, result: ok(shared) },
      { toolId: 'metrics', input: { service: 'payments', metric: 'probe-b' }, result: ok(shared) },
    ],
  };
  const fact = { form: 'signal-state', subject: 'payments', window: 'incident', signal: 'error-rate', state: 'elevated' };
  const executor = createPlannedReplayExecutor({
    fixture,
    routes: graph.INVESTIGATION_ROUTES,
    annotate: (_identity, evidence) => (evidence.id === shared.id ? [fact] : undefined),
  });

  const result = await executor.execute(
    baseContext({ tool: 'metrics', input: { service: 'payments', window: 'incident', metric: 'error-rate' } }),
  );

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output.map((item) => item.id), ['metric-payments-shared']);
});

test('refuses at construction a route table in which two forms name the same tool, since a request for that tool could not be read back into one quantity', () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();
  const routes = {
    version: 'ambiguous-v1',
    byForm: {
      'signal-state': { tool: 'metrics', input: { service: 'subject', window: 'window', metric: 'signal' } },
      'log-class-in-window': { tool: 'metrics', input: { service: 'subject', window: 'window', metric: 'logClass' } },
    },
  };

  assert.throws(
    () => createPlannedReplayExecutor({ fixture: { version: 1, entries: [] }, routes, annotate: () => undefined }),
    (error) => error instanceof TypeError && /metrics/.test(error.message),
  );
});

test('INVESTIGATION_ROUTES names each tool at most once, so every routed request reads back into exactly one quantity', () => {
  const tools = Object.values(graph.INVESTIGATION_ROUTES.byForm).map((route) => route.tool);
  assert.equal(new Set(tools).size, tools.length);
});

test('replayFixtureFromScenarioEntries carries the scenario fixture version through, so a fixture at an unknown version is refused by the replay adapter rather than silently reinterpreted', () => {
  const replayFixtureFromScenarioEntries = requireReplayFixtureFromScenarioEntries();

  const converted = replayFixtureFromScenarioEntries({ version: 99, entries: [] });

  assert.equal(converted.version, 99);
  assert.throws(() => new ReplayToolAdapter(converted));
});

test('an ok recorded result whose output is not an array answers unavailable rather than rejecting', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();
  const fixture = {
    version: 1,
    entries: [{ toolId: 'metrics', input: { service: 'payments', metric: 'probe' }, result: { status: 'ok', output: null } }],
  };
  const executor = createPlannedReplayExecutor({ fixture, routes: graph.INVESTIGATION_ROUTES, annotate: () => undefined });

  const result = await executor.execute(
    baseContext({ tool: 'metrics', input: { service: 'payments', window: 'incident', metric: 'error-rate' } }),
  );

  assert.equal(result.status, 'unavailable');
});

test('dependency-caused-incident-b: a planned deployment request for payments answers ok with the pre-onset deployment fact although the scenario\'s cause is inventory-api, measured off the frozen corpus: answerability does not track the ground truth', async () => {
  const createPlannedReplayExecutor = requireCreatePlannedReplayExecutor();
  const { fixture } = scenario('dependency-caused-incident-b');
  assert.notEqual(
    evals.STRUCTURAL_GROUND_TRUTH['dependency-caused-incident-b'].rootCause.component,
    'payments',
    'fixture sanity: payments is not this scenario\'s root cause',
  );
  const [deployment] = plannedTestsFor('payments');
  assert.equal(deployment.tool, 'deployments');
  const executor = createPlannedReplayExecutor({
    fixture,
    routes: graph.INVESTIGATION_ROUTES,
    annotate: evals.createObservationAnnotator(),
  });

  const result = await executor.execute(baseContext({ tool: deployment.tool, input: deployment.input }));

  assert.equal(result.status, 'ok');
  assert.ok(
    result.output.some((item) =>
      item.observation?.facts.some((fact) => fact.form === 'deployment-in-window' && fact.window === 'pre-onset'),
    ),
    'the answer carries the pre-onset deployment fact',
  );
});
