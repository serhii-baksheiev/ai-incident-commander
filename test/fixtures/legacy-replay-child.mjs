/**
 * AIC-100 slice d: the child-process half of
 * test/legacy-adapters-on-registry.test.mjs's "a legacy corpus migrated to v2
 * and written to a file store replays identically in a freshly spawned child
 * process" row. Spawned fresh by the parent — a genuinely separate node
 * process, its own module registry and its own in-memory state — after the
 * parent has already migrated a legacy (v1-shaped) corpus and written every
 * recording into the SAME file on disk. Opens a brand-new file replay store
 * over that path, replays every entry through a fresh replay-mode registry
 * built from `createIncidentToolSource` bindings, and prints the extracted
 * ToolResult ("output") for each entry, in order, as one JSON array on
 * stdout — so the parent can compare it against the entries' own `result`
 * fields.
 *
 * argv: [filePath, corpusJson] where corpusJson is
 * `JSON.stringify([{ toolId, input }, ...])`, the same entries (minus their
 * `result`) the parent migrated and wrote into the file store at filePath.
 *
 * Every bound tool's own `execute()` throws unconditionally — a registry bug
 * that fell through to the real tool in replay mode would fail loudly here
 * instead of silently returning a plausible-looking result.
 *
 * Uses `@aic/tools`'s BUILT package (the workspace symlink under
 * node_modules resolves to packages/tools/dist), exactly the way every other
 * suite file in this repository imports it — never a relative path into
 * packages/tools/src.
 */
import { createBoundSourceRegistry, createFileReplayStore, createIncidentToolSource } from '@aic/tools';

const [, , filePath, corpusJson] = process.argv;

// `npm test` runs bare `node --test`, which auto-discovers every file under
// test/ — including this one, with no argv. Exit quietly rather than touch
// the filesystem or throw on undefined arguments; the real invocation always
// passes both (see test/legacy-adapters-on-registry.test.mjs's spawnSync call).
if (filePath === undefined || corpusJson === undefined) {
  process.exit(0);
}

const corpus = JSON.parse(corpusJson);

const bindings = corpus.map(({ toolId }) => ({
  sourceBindingId: toolId,
  source: createIncidentToolSource({
    id: toolId,
    risk: 'read',
    async execute() {
      throw new Error(
        'FAKE_TOOL_MUST_NOT_BE_CALLED: replay mode reached the real tool instead of the recorded outcome',
      );
    },
  }),
  credentialRefId: null,
}));

const registry = createBoundSourceRegistry({
  mode: 'replay',
  store: createFileReplayStore(filePath),
  // A clock that must NEVER be consulted for fetchedAt in replay mode — a
  // sentinel date far from the one the parent recorded/migrated under.
  clock: () => new Date('2099-01-01T00:00:00.000Z'),
  bindings,
});

const outputs = [];
for (const { toolId, input } of corpus) {
  const outcome = await registry.execute(toolId, toolId, input);
  outputs.push(outcome.status === 'ok' ? outcome.output : outcome);
}
process.stdout.write(JSON.stringify(outputs));
