/**
 * AIC-100 slice b: the child-process half of
 * test/bound-source-registry.test.mjs's "Record/replay is deterministic
 * across process restart" row. Spawned fresh by the parent — a genuinely
 * separate node process, its own module registry and its own in-memory
 * state — after the parent has already recorded into the SAME file on disk.
 * Opens a brand-new file replay store over that path, replays the one
 * recorded call, and prints the outcome as JSON on stdout so the parent can
 * compare it byte-for-byte with what it recorded.
 *
 * argv: [filePath, sourceBindingId, credentialRefIdOrEmpty]
 *
 * Uses `@aic/tools`'s BUILT package (the workspace symlink under
 * node_modules resolves to packages/tools/dist), exactly the way every other
 * suite file in this repository imports it — never a relative path into
 * packages/tools/src.
 */
import { createBoundSourceRegistry, createFileReplayStore } from '@aic/tools';

import {
  FIXTURE_INPUT,
  FIXTURE_OPERATION,
  createDeterministicEvidenceSource,
} from './bound-source-registry-fixture-source.mjs';

const [, , filePath, sourceBindingId, credentialRefIdRaw] = process.argv;
const credentialRefId = credentialRefIdRaw === '' ? null : credentialRefIdRaw;

const registry = createBoundSourceRegistry({
  mode: 'replay',
  store: createFileReplayStore(filePath),
  // A clock that must NEVER be consulted for fetchedAt in replay mode — a
  // sentinel date far from the one the parent recorded. If replay ever fell
  // back to the live clock instead of the recorded value, the parent's
  // deep-equal assertion against its own recorded outcome would catch this
  // date leaking through.
  clock: () => new Date('2099-01-01T00:00:00.000Z'),
  bindings: [
    {
      sourceBindingId,
      source: createDeterministicEvidenceSource({ refuseToBeCalled: true }),
      credentialRefId,
    },
  ],
});

const outcome = await registry.execute(sourceBindingId, FIXTURE_OPERATION, FIXTURE_INPUT);
process.stdout.write(JSON.stringify(outcome));
