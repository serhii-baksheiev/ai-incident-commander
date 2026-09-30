import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The postgres image's entrypoint runs a temporary server during initdb that
 * listens only on the unix socket, then stops it and starts the real one.
 * `pg_isready` with no `--host` probes that socket, so a healthcheck written
 * that way reports healthy against the temporary server and `docker compose
 * up --wait` (or a CI service container) hands over a database that is about
 * to shut down — measured as "Connection terminated unexpectedly" in the live
 * lane. Probing 127.0.0.1 over TCP only succeeds once the real server listens.
 *
 * A text read, so `npm run check` needs no Docker. It fails closed: every file
 * listed here must carry at least one `pg_isready`, and every line naming it
 * must name the TCP host too.
 */
const HEALTHCHECK_FILES = ['infra/postgres/compose.yaml', 'infra/single-user/compose.yaml', '.github/workflows/ci.yml'];

for (const relativePath of HEALTHCHECK_FILES) {
  test(`every pg_isready healthcheck in ${relativePath} probes 127.0.0.1 over TCP`, () => {
    const lines = readFileSync(join(projectRoot, relativePath), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#') && line.includes('pg_isready'));

    assert.ok(lines.length > 0, `${relativePath} must still carry a pg_isready healthcheck for this row to check`);
    for (const line of lines) {
      assert.match(
        line,
        /--host"?,?\s*"?127\.0\.0\.1/,
        `${relativePath}: this pg_isready probes the unix socket, which answers during initdb's temporary server: ${line.trim()}`,
      );
    }
  });
}
