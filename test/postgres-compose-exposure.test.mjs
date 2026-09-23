import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const composePath = join(projectRoot, 'infra', 'postgres', 'compose.yaml');

/**
 * The PostgreSQL compose file runs with `POSTGRES_HOST_AUTH_METHOD: trust`, so
 * anything that can reach its port is a superuser. The loopback prefix on the
 * published port is therefore the whole of its protection, and dropping it is a
 * one-token edit. `incident-lab/tests/bad-deployment.live.mjs` pins the same
 * property for the lab's unauthenticated API, but only inside a Docker-backed
 * lane; this row reads the file itself so the ordinary suite, and CI, catch it.
 *
 * Deliberately a text read rather than `docker compose config`: `npm run check`
 * must not need Docker. The price is that it reads the `ports:` entries as
 * written, one per line, which is the only form this file uses.
 */
const publishedPorts = (compose) => {
  const lines = compose.split('\n');
  const entries = [];
  let inPorts = false;
  let portsIndent = -1;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (/^ports:\s*$/.test(trimmed)) {
      inPorts = true;
      portsIndent = indent;
      continue;
    }
    if (!inPorts || trimmed === '' || trimmed.startsWith('#')) continue;
    if (indent <= portsIndent) {
      inPorts = false;
      continue;
    }
    const entry = /^-\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/.exec(trimmed);
    if (entry) entries.push(entry[1]);
  }
  return entries;
};

test('publishes the trust-auth PostgreSQL port on loopback only', () => {
  const compose = readFileSync(composePath, 'utf8');

  assert.match(
    compose,
    /POSTGRES_HOST_AUTH_METHOD:\s*trust/,
    'this row exists because the container trusts every connection; if that changed, re-read what this row should protect',
  );

  const ports = publishedPorts(compose);
  assert.ok(ports.length > 0, 'the compose file must publish its port somewhere for this row to have anything to check');
  for (const port of ports) {
    assert.ok(
      port.startsWith('127.0.0.1:'),
      `published port "${port}" is not bound to 127.0.0.1: with trust authentication, a port reachable off this machine hands a superuser to anyone who can connect`,
    );
  }
  assert.doesNotMatch(compose, /network_mode:\s*["']?host/, 'host networking would bypass the published-port binding entirely');
});
