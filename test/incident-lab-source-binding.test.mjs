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
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

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
