/**
 * AIC-98, slice a: "Incident Lab live scenarios use a SourceBinding rather
 * than ad-hoc injected tools." `incident-lab/src/scenario-candidates.mjs`
 * currently builds an ad-hoc observation tool inline (`createObservationTool`)
 * and wraps it in `LiveToolAdapter` (`@aic/tools/live`). This slice routes
 * those observations through `createBoundSourceRegistry`
 * (`packages/tools/src/bound-source-registry.ts`) with one binding of the
 * new `createLabEvidenceSource` (`packages/tools/src/evidence-source.ts` /
 * test/lab-evidence-source.test.mjs), `sourceBindingId: 'incident-lab'`,
 * `expectedAdapter: 'lab@1'`, `credentialRefId: null`.
 *
 * Pinned here by SOURCE INSPECTION rather than a Docker-backed behavioural
 * run, per the owner-approved plan for this slice: this file reads
 * `incident-lab/src/scenario-candidates.mjs`'s own text and asserts the
 * import/definition shape the refactor must land in. A behavioural row
 * distinguishing the two implementations would need to pin the exact wording
 * `buildCandidate`'s failure branch throws on a refused observation, which
 * the ticket does not specify (see this run's report for why: tracing the
 * CURRENT code path shows `LiveToolAdapter` already collapses every HTTP
 * failure through `BoundSourceRegistry`'s own `classifyEvidenceSourceFailure`
 * into a fixed `adapter_error` message today, so a row asserting "the raw
 * upstream body text never leaks" would already be green under the
 * pre-refactor code — it would not discriminate the two implementations
 * without inventing the new failure-message text as an API decision this
 * file has no license to make).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { createReplayFixtureKey } from '@aic/tools';
import { REPLAY_FIXTURE_VERSION } from '@aic/tools/replay';

import { recordScenarioCandidate } from '../incident-lab/src/scenario-candidates.mjs';
import {
  findLiveScenario,
  LAB_TOPOLOGY_VERSION,
} from '../incident-lab/scenario-definitions.mjs';

const scenarioCandidatesPath = resolve('incident-lab/src/scenario-candidates.mjs');

test('scenario-candidates.mjs imports createLabEvidenceSource and createBoundSourceRegistry from @aic/tools (AIC-98 slice a)', async () => {
  const source = await readFile(scenarioCandidatesPath, 'utf8');

  assert.match(
    source,
    /createLabEvidenceSource/,
    'scenario-candidates.mjs must import createLabEvidenceSource from @aic/tools to build its lab@1 EvidenceSource (AIC-98 slice a)',
  );
  assert.match(
    source,
    /createBoundSourceRegistry/,
    'scenario-candidates.mjs must route observations through createBoundSourceRegistry rather than LiveToolAdapter (AIC-98 slice a)',
  );
});

test('scenario-candidates.mjs no longer defines the ad-hoc createObservationTool, once observations route through a SourceBinding (AIC-98 slice a)', async () => {
  const source = await readFile(scenarioCandidatesPath, 'utf8');

  assert.doesNotMatch(
    source,
    /createObservationTool/,
    'scenario-candidates.mjs must stop defining the ad-hoc createObservationTool — observations route through createLabEvidenceSource + createBoundSourceRegistry instead (AIC-98 slice a)',
  );
});

test('scenario-candidates.mjs no longer imports LiveToolAdapter, once observations route through a SourceBinding (AIC-98 slice a)', async () => {
  const source = await readFile(scenarioCandidatesPath, 'utf8');

  assert.doesNotMatch(
    source,
    /LiveToolAdapter/,
    'scenario-candidates.mjs must stop importing LiveToolAdapter from @aic/tools/live — the ad-hoc per-tool wrapper is replaced by one incident-lab SourceBinding (AIC-98 slice a)',
  );
});

test('scenario-candidates.mjs still keeps the embedded v1 replay fixture keyed with createReplayFixtureKey (byte-compatible candidate format, AIC-98 acceptance)', async () => {
  const source = await readFile(scenarioCandidatesPath, 'utf8');

  assert.match(
    source,
    /createReplayFixtureKey/,
    'scenario-candidates.mjs must keep using createReplayFixtureKey to key its embedded replay fixture — the candidate file format stays byte-compatible across this refactor (AIC-98 acceptance)',
  );
});

/**
 * Behavioural row (code-reviewer, round 1 blocker): the source-inspection
 * rows above pin the refactor's import/definition shape, but nothing yet
 * drives `recordScenarioCandidate` end to end. This row does, against a real
 * loopback `node:http` fake lab server — the same pattern
 * test/incident-lab-request-security.test.mjs:83 already uses for the same
 * entry point — so the SourceBinding plumbing (request shape, candidate
 * envelope, embedded replay fixture) is pinned by running code, not just by
 * grepping for identifiers.
 */
async function startFakeLabServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  return `http://127.0.0.1:${address.port}`;
}

test('recordScenarioCandidate drives the incident-lab SourceBinding end to end against a fake lab server: request shape, candidate envelope, per-call results and the embedded replay fixture (AIC-98 slice a, code-reviewer round 1)', async (t) => {
  const scenario = findLiveScenario('bad-deployment');
  assert.notEqual(scenario, undefined, 'the bad-deployment v1 fixture scenario must still be registered');

  const fakeResponsesByToolId = {
    deployments: { lines: ['fixture: deployment observation output'] },
    logs: { lines: ['fixture: log observation output'] },
  };

  const recordedRequests = [];
  const baseUrl = await startFakeLabServer(t, (request, response) => {
    recordedRequests.push({ method: request.method, url: request.url });
    const toolId = request.url.replace(/^\/observations\//, '').split('?')[0];
    const body = fakeResponsesByToolId[toolId];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(`${JSON.stringify(body)}\n`);
  });

  const candidateDirectory = mkdtempSync(join(tmpdir(), 'aic98-candidate-'));
  t.after(() => rmSync(candidateDirectory, { recursive: true, force: true }));

  const { candidatePath, candidate } = await recordScenarioCandidate({
    baseUrl,
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    candidateDirectory,
  });

  // The requests the fake server received: GET /observations/<toolId>?<query>,
  // for the scenario's observations, in order.
  const expectedRequests = scenario.observations.map(({ toolId, input }) => ({
    method: 'GET',
    url: `/observations/${toolId}?${new URLSearchParams(input).toString()}`,
  }));
  assert.deepEqual(
    recordedRequests,
    expectedRequests,
    'recordScenarioCandidate must issue one GET /observations/<toolId>?<query> request per scenario observation, in order',
  );

  // Every recordedCalls[i].result deep-equals the ok outcome the fake server served.
  assert.equal(candidate.recordedCalls.length, scenario.observations.length);
  scenario.observations.forEach(({ toolId, input }, index) => {
    const recordedCall = candidate.recordedCalls[index];
    assert.deepEqual(recordedCall.toolId, toolId);
    assert.deepEqual(recordedCall.input, input);
    assert.deepEqual(
      recordedCall.result,
      { status: 'ok', output: fakeResponsesByToolId[toolId] },
      `recordedCalls[${index}].result must be exactly { status: 'ok', output: <the body the fake server served> }`,
    );
  });

  // The written candidate envelope's fields, as the existing format defines them.
  assert.equal(candidate.schemaVersion, 1);
  assert.equal(candidate.scenarioId, scenario.id);
  assert.equal(candidate.scenarioVersion, scenario.version);
  assert.equal(candidate.labTopologyVersion, LAB_TOPOLOGY_VERSION);

  // The embedded replay fixture: keyed by createReplayFixtureKey(toolId,
  // input) for each observation, with values equal to those same results.
  assert.equal(candidate.replayFixture.version, REPLAY_FIXTURE_VERSION);
  const expectedResponseKeys = scenario.observations
    .map(({ toolId, input }) => createReplayFixtureKey(toolId, input))
    .sort();
  assert.deepEqual(
    Object.keys(candidate.replayFixture.responses).sort(),
    expectedResponseKeys,
  );
  scenario.observations.forEach(({ toolId, input }) => {
    const key = createReplayFixtureKey(toolId, input);
    assert.deepEqual(
      candidate.replayFixture.responses[key],
      { status: 'ok', output: fakeResponsesByToolId[toolId] },
      `replayFixture.responses[${JSON.stringify(key)}] must equal the recorded result for ${toolId}`,
    );
  });

  // The file actually written to disk carries the same envelope.
  const onDisk = JSON.parse(readFileSync(candidatePath, 'utf8'));
  assert.deepEqual(onDisk, candidate, 'the file written at candidatePath must equal the returned candidate');
});
