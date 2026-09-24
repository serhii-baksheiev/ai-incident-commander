/**
 * AIC-58, slice c: `run_events` is a product timeline for SSE
 * reconnect/history/audit support, never an event store — "no code
 * reconstructs domain aggregates from run_events" is this file's acceptance
 * row. `test/postgres-checkpointer.test.mjs` already keeps the table's NAME
 * out of every layer but `packages/persistence` (its "keeps checkpointer
 * storage..." row); this file adds the narrower boundary INSIDE
 * `packages/persistence/src` itself: which modules may even name the table,
 * and which module is allowed to write it.
 *
 * ## Premise found false against the task brief
 *
 * The brief states the naming boundary is exactly four files: `app-schema.ts`
 * (DDL), `run-write-context.ts` (writer), `run-event-stream.ts` (reader/tail
 * source), `retention.ts` (product-snapshot reader). Measured with a plain
 * `\brun_events\b` scan over `packages/persistence/src/*.ts`:
 * `index.ts` ALSO matches — its AIC-58 slice-a doc comment says "a durable,
 * tail/poll `RunEventStreamSource` (...) over `aic_app.run_events`". That is
 * prose describing what `run-event-stream.ts` re-exports, not a fifth module
 * that talks to the table — but the mechanical scan below cannot tell the
 * difference between a doc comment and a live SQL string, any more than
 * `test/postgres-checkpointer.test.mjs`'s own `STORAGE_SURFACE` scan can (see
 * that file's row 7 comment: "a table name in a SQL string is not an import
 * edge at all"). So this row is pinned to the four-file boundary the ticket
 * actually wants, and is RED against the repository as it stands today until
 * `index.ts`'s comment is reworded (or the module is added to the allow-list
 * deliberately, in which case this test's own allow-list is the place that
 * decision gets made on purpose rather than by drift).
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const PERSISTENCE_SRC = resolve(projectRoot, 'packages/persistence/src');

/**
 * Every module allowed to even NAME `run_events` — deliberately just the
 * four the ticket names, so a fifth mention (a new module, or an existing
 * one growing a stray reference) has to be added here on purpose. See this
 * file's header for why `index.ts` is not on this list despite currently
 * matching the scan.
 */
const ALLOWED_TO_NAME_RUN_EVENTS = Object.freeze([
  'app-schema.ts',
  'run-write-context.ts',
  'run-event-stream.ts',
  'retention.ts',
]);

/** The one module allowed to write (INSERT/UPDATE) run_events — the append-only writer. */
const ALLOWED_TO_WRITE_RUN_EVENTS = 'run-write-context.ts';

function persistenceSourceFiles() {
  return readdirSync(PERSISTENCE_SRC)
    .filter((entry) => entry.endsWith('.ts'))
    .filter((entry) => statSync(join(PERSISTENCE_SRC, entry)).isFile());
}

test('within packages/persistence/src, only app-schema.ts, run-write-context.ts, run-event-stream.ts and retention.ts may name the run_events table, and only run-write-context.ts writes it', () => {
  const files = persistenceSourceFiles();

  // Non-vacuity: this row looks at nothing if the directory listing ever came
  // back empty (a moved package, a renamed src directory) — the same failure
  // mode test/postgres-checkpointer.test.mjs's own row 7 guards against for
  // its apps/ walk.
  assert.ok(
    files.includes('run-write-context.ts') && files.includes('app-schema.ts'),
    `packages/persistence/src must contain run-write-context.ts and app-schema.ts for this scan to mean anything; found: ${JSON.stringify(files)}`,
  );

  const TABLE_NAME = /\brun_events\b/;
  const namingFiles = files.filter((file) => TABLE_NAME.test(readFileSync(join(PERSISTENCE_SRC, file), 'utf8')));

  assert.deepEqual(
    namingFiles.slice().sort(),
    ALLOWED_TO_NAME_RUN_EVENTS.slice().sort(),
    `only ${JSON.stringify(ALLOWED_TO_NAME_RUN_EVENTS)} may name run_events in packages/persistence/src; the scan found ${JSON.stringify(namingFiles.sort())} — a module naming the table outside this list must be added to the allow-list deliberately, not by drift`,
  );

  const WRITE_STATEMENT = /\b(INSERT\s+INTO|UPDATE)\b[^;]*\brun_events\b/is;
  const writingFiles = namingFiles.filter((file) =>
    WRITE_STATEMENT.test(readFileSync(join(PERSISTENCE_SRC, file), 'utf8')),
  );

  assert.deepEqual(
    writingFiles,
    [ALLOWED_TO_WRITE_RUN_EVENTS],
    `run_events is append-only: only ${ALLOWED_TO_WRITE_RUN_EVENTS} may INSERT or UPDATE it; the scan found ${JSON.stringify(writingFiles)} issuing one`,
  );

  // retention.ts prunes a terminal run's node_results, never run_events — its
  // own DELETE statement is pinned by kind here so a future change that
  // widened it to run_events (turning the product timeline into something
  // retention rewrites) would redden this row rather than pass silently
  // alongside the write-statement check above, which only looks for
  // INSERT/UPDATE and would not itself catch a DELETE.
  const retentionSource = readFileSync(join(PERSISTENCE_SRC, 'retention.ts'), 'utf8');
  assert.match(
    retentionSource,
    /DELETE FROM "\$\{APPLICATION_SCHEMA\}"\.node_results/,
    'retention.ts must prune node_results, not run_events — the run_events table is never rewritten by retention',
  );
  assert.doesNotMatch(
    retentionSource,
    /\bDELETE\b[^;]*\brun_events\b/is,
    'retention.ts must never issue a DELETE against run_events: the product timeline is never pruned or rewritten, only node_results is',
  );

  // Acceptance criterion, stated narrowly: the only production reader of
  // run_events besides the stream source itself is retention.ts's
  // readRunProductSnapshot, and that function returns run_events verbatim as
  // opaque {seq, type, executionAttempt, payload} rows for the product-API
  // timeline — it does not fold them into a Trial, Evidence, or run status.
  // Those instead come from run_trials, run_evidence and runs.status directly
  // (see retention.ts's own SELECTs). This pins that shape rather than
  // trusting the module's doc comment (`.claude/rules/invariants.md`'s "a
  // sentence describing behaviour is either generated or a pointer to a
  // test") — folded into this same test so the file's one Red assertion
  // (the naming boundary above) does not leave this acceptance criterion
  // sitting in an already-green, unexercised test of its own.
  assert.match(
    retentionSource,
    /events:\s*eventRows\.map\(\(row\)\s*=>\s*\(\{\s*seq:\s*Number\(row\.seq\),\s*type:\s*row\.type,\s*executionAttempt:\s*Number\(row\.execution_attempt\),\s*payload:\s*row\.payload,\s*\}\)\)/s,
    'readRunProductSnapshot must project run_events as opaque {seq, type, executionAttempt, payload} rows, never fold them into a Trial, Evidence, or run status — those come from run_trials/run_evidence/runs directly',
  );
  assert.doesNotMatch(
    retentionSource,
    /TrialSchema\.parse\([^)]*eventRows/,
    'run_events rows must never be parsed as a Trial: trials come from run_trials only',
  );
  assert.doesNotMatch(
    retentionSource,
    /EvidenceSchema\.parse\([^)]*eventRows/,
    'run_events rows must never be parsed as Evidence: evidence comes from run_evidence only',
  );
});
