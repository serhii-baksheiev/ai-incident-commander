/**
 * AIC-146 slice b5, end-to-end row: a full `createInvestigationGraph` run,
 * driven by the same scripted-control harness `scripts/lane-arms.mjs`'s
 * `scriptedNodes` and `test/lane-arms-golden.test.mjs` already use
 * (`createScriptedReasoning`, `@aic/roles`), but with `execute` wired to a
 * REAL `createBoundInvestigationExecutor` (`@aic/tools`, AIC-146 b3) over one
 * real lab@1 `SourceBinding`, answered by a stub `fetch` rather than a
 * recorded replay fixture. Unlike `test/lane-arms-golden.test.mjs` (the
 * planned-replay executor, never a live source) and
 * `test/investigation-execution-bound-port.test.mjs` (the bound port driven
 * through the node alone, on a 403), this file runs the whole canonical
 * graph to completion and inspects what it commits to `IncidentState`.
 *
 * `createScriptedReasoning`'s `challenge_hypothesis` plans exactly one
 * discriminating test, `{ tool: fixture.entries[0].toolId, input: { replay:
 * true } }` (`packages/roles/src/scripted-reasoning.ts`) — a fixed shape that
 * names no `REPLAY_SCENARIOS` fixture at all, so there is nothing here for a
 * recorded fixture to (mis)match. The fixture below names `deployments`, the
 * one `READ_ONLY_TOOL_REGISTRY` tool this file's own stub answers; the stub
 * answers that request with a fixed Evidence-shaped item, "whatever is
 * asked", exactly as a stub is allowed to.
 *
 * The composition passes `evidenceProvenance: 'required'` (AIC-146 b5) to
 * `createInvestigationNodes`. A real `BoundSourceRegistry` never returns an
 * `ok` outcome without a well-formed `provenance` (AIC-146 b1/b3), so this
 * run is expected to complete with `'required'` in force exactly as it would
 * with the option omitted — the row's job is to prove the whole pipeline
 * still stamps every recorded Evidence, not to provoke the option's own
 * refusal (`investigation-execution.test.mjs`'s "AIC-146 b5" section already
 * pins that in isolation).
 *
 * Independent oracle for `requestFingerprint`: `createRequestFingerprint`
 * (`@aic/tools`) and `canonicalJson` (`@aic/domain`) are never imported here.
 * The envelope is hand-built the same way
 * `test/evidence-source-contract.test.mjs`'s own "matches an independently
 * computed sha256" row hand-builds it — `sortKeysDeep`, below, is a
 * deliberately separate, from-scratch re-sort of `{ input, operation }`, not
 * a copy of `@aic/domain`'s `canonicalJson` (`.claude/rules/invariants.md`,
 * "the independent-oracle invariant").
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as graph from '@aic/graph';
import * as tools from '@aic/tools';
import { createScriptedReasoning } from '@aic/roles';

const RUN_ID = 'run-bound-port-investigation-e2e';
const CLOCK_ISO = '2026-09-29T00:00:00.000Z';
const fixedClock = () => new Date(CLOCK_ISO);

const TEST_PRIMARY_SCOPE = Object.freeze({
  serviceId: '11111111-1111-4111-8111-111111111111',
  environmentId: '22222222-2222-4222-8222-222222222222',
});

/** Restated locally, matching test/investigation-execution-bound-port.test.mjs's own fixture shape (that file exports nothing for reuse). */
function makeBinding(overrides = {}) {
  return domain.SourceBindingSchema.parse({
    id: randomUUID(),
    environmentId: randomUUID(),
    adapterId: 'lab',
    adapterVersion: '1',
    name: 'lab-primary',
    config: { baseUrl: 'http://127.0.0.1:9999' },
    credentialRefId: null,
    ...overrides,
  });
}

function fakeResponse({ status, body }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

/**
 * Answers "whatever is asked": every `/observations/<toolId>` request gets
 * the same fixed, Evidence-shaped item back, regardless of its query string —
 * it is a stub, not a second recorded fixture. A `/health` probe (none of
 * this file's rows ever trigger one; `BoundSourceRegistry.execute` never
 * calls `check()`) still answers `ok`, so a future caller of this stub is not
 * surprised by an unhandled path.
 */
function createLabStubFetch() {
  const calls = [];
  const fetchFn = async (url) => {
    const parsed = new URL(url.toString());
    calls.push(parsed.toString());
    if (parsed.pathname === '/health') {
      return fakeResponse({ status: 200, body: {} });
    }
    return fakeResponse({
      status: 200,
      body: [
        {
          id: 'lab-stub-evidence-1',
          trialId: 'placeholder-trial-lab-stub',
          kind: 'deploy',
          source: 'lab',
          observedAt: CLOCK_ISO,
          statement: 'checkout deployed in the incident window',
          rawRef: 'lab://deployments/1',
        },
      ],
    });
  };
  fetchFn.calls = calls;
  return fetchFn;
}

async function unreachableResolveSecret() {
  throw new Error('RESOLVE_SECRET_MUST_NOT_BE_CALLED_FOR_A_CREDENTIAL_LESS_BINDING');
}

function baseControl(overrides = {}) {
  return {
    runId: RUN_ID,
    schemaVersion: domain.INCIDENT_STATE_SCHEMA_VERSION,
    statusRulesVersion: domain.STATUS_RULES_VERSION,
    phase: 'normalizing',
    maxIterations: 4,
    llmCallBudget: 8,
    reservedChallengeBudget: 2,
    challengeRounds: 0,
    iterationsUsed: 0,
    llmCallsUsed: 0,
    resumeCount: 0,
    humanReview: false,
    ...overrides,
  };
}

function initialState(overrides = {}) {
  return {
    incident: { id: 'incident-bound-port-investigation-e2e', primaryScope: TEST_PRIMARY_SCOPE },
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: baseControl(),
    ...overrides,
  };
}

/**
 * A deliberately separate, from-scratch re-implementation of canonical key
 * sorting — never `@aic/domain`'s `canonicalJson`, and never
 * `@aic/tools`'s `createRequestFingerprint` — so the fingerprint assertion
 * below cannot be satisfied merely by production checking its own work
 * (`.claude/rules/invariants.md`, "the independent-oracle invariant").
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (typeof value === 'object' && value !== null) {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

function handComputedRequestFingerprint(operation, input) {
  const envelope = JSON.stringify(sortKeysDeep({ input, operation }));
  return `sha256:${createHash('sha256').update(envelope).digest('hex')}`;
}

test('a full createInvestigationGraph run over a real bound-source port with a lab@1 stub completes, records at least one Evidence, and every recorded Evidence carries its own provenance naming the lab binding, independently fingerprinted (AIC-146 b5)', async () => {
  const binding = makeBinding();
  const fetchFn = createLabStubFetch();

  const constructed = await tools.createBoundInvestigationExecutor({
    bindings: [binding],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: fetchFn,
    resolveSecret: unreachableResolveSecret,
  });
  assert.equal(constructed.ok, true, `expected construction to succeed, got: ${JSON.stringify(constructed)}`);

  const fixture = { entries: [{ toolId: 'deployments', input: { replay: true } }] };
  const nodes = graph.createInvestigationNodes({
    reasoning: createScriptedReasoning({ runId: RUN_ID, fixture }),
    execute: constructed.executor.execute,
    asOf: () => CLOCK_ISO,
    evidenceProvenance: 'required',
  });

  const investigationGraph = graph.createInvestigationGraph({ nodes });

  const result = await investigationGraph.execute({ kind: 'start', state: initialState() });

  // Non-vacuity floor: if this ever drops to zero, the run stopped reaching
  // the bound port at all and every assertion below has nothing left to check.
  assert.ok(
    result.evidence.length > 0,
    `expected at least one Evidence item to be recorded, got zero (trials: ${JSON.stringify(result.trials)})`,
  );

  for (const item of result.evidence) {
    domain.EvidenceSchema.parse(item);
    assert.equal(
      Object.hasOwn(item, 'provenance'),
      true,
      `evidence ${item.id} must carry its own provenance; the run was composed with evidenceProvenance: 'required'`,
    );
    assert.equal(item.provenance.sourceBindingId, binding.id, 'provenance must name the one lab@1 binding this run used');
    assert.equal(item.provenance.adapter, 'lab@1');

    const producingTrial = result.trials.find((trial) => trial.id === item.trialId);
    assert.ok(producingTrial, `evidence ${item.id} must point at a trial actually present in the run's own result`);

    assert.equal(
      item.provenance.requestFingerprint,
      handComputedRequestFingerprint(producingTrial.tool, producingTrial.input),
      'requestFingerprint must equal an independently, hand-computed sha256 over the canonical envelope of the producing trial\'s own tool and input',
    );
  }

  assert.ok(fetchFn.calls.length > 0, 'the stub fetch must actually have been reached at least once');
});
