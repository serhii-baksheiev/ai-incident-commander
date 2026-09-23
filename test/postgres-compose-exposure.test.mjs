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
 * one-token edit. The lab pins the same property for its unauthenticated API,
 * but only inside a Docker-backed lane — `incident-lab/tests/bad-deployment.live.mjs`
 * › "records a reviewable bad-deployment candidate that replays after isolated resets"; this row
 * reads the file itself so the ordinary suite, and CI, catch it.
 *
 * Deliberately a text read rather than `docker compose config`: `npm run check`
 * must not need Docker. So the reader understands exactly two shapes — a block
 * `ports:` followed by `- "host:port:port"` lines, and an inline
 * `ports: ["…", …]` — and it fails CLOSED on anything else: every `ports:` key
 * must yield at least one entry it could read, or the row is red. An entry it
 * reads is judged; an entry it cannot read makes its block empty, and an empty
 * block is a failure, never a pass.
 */
const portBlocks = (compose) => {
  const blocks = [];
  let current = null;
  for (const line of compose.split('\n')) {
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const key = /^ports:\s*(.*)$/.exec(trimmed);
    if (key) {
      const inline = key[1].replace(/\s+#.*$/, '').trim();
      if (inline === '') {
        current = { indent, entries: [] };
        blocks.push(current);
      } else {
        const flow = /^\[(.*)\]$/.exec(inline);
        const entries = flow
          ? flow[1].split(',').map((item) => item.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
          : [];
        blocks.push({ indent, entries });
        current = null;
      }
      continue;
    }

    if (!current) continue;
    if (indent < current.indent || (indent === current.indent && !trimmed.startsWith('-'))) {
      current = null;
      continue;
    }
    const entry = /^-\s*(?:"([^"]*)"|'([^']*)'|([^\s#"']+))\s*(?:#.*)?$/.exec(trimmed);
    const value = entry ? (entry[1] ?? entry[2] ?? entry[3]) : null;
    if (value && value.includes(':') && !/^[a-z_]+:\s/.test(value)) current.entries.push(value);
  }
  return blocks;
};

const assertLoopbackOnly = (compose) => {
  const blocks = portBlocks(compose);
  assert.ok(blocks.length > 0, 'the compose file must publish a port somewhere for this row to have anything to check');
  for (const [index, block] of blocks.entries()) {
    assert.ok(
      block.entries.length > 0,
      `ports block ${index + 1} yielded no entry this reader understands; it fails closed rather than pass a shape it cannot judge`,
    );
    for (const port of block.entries) {
      assert.ok(
        port.startsWith('127.0.0.1:'),
        `published port "${port}" is not bound to 127.0.0.1: with trust authentication, a port reachable off this machine hands a superuser to anyone who can connect`,
      );
    }
  }
  const uncommented = compose
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(uncommented, /network_mode:\s*["']?host/, 'host networking would bypass the published-port binding entirely');
};

test('publishes the trust-auth PostgreSQL port on loopback only', () => {
  const compose = readFileSync(composePath, 'utf8');
  assert.match(
    compose,
    /POSTGRES_HOST_AUTH_METHOD:\s*trust/,
    'this row exists because the container trusts every connection; if that changed, re-read what this row should protect',
  );
  assertLoopbackOnly(compose);
});

test('fails closed on a second service whose ports it binds off loopback, in either shape it reads or one it cannot', () => {
  const compliant = [
    'services:',
    '  postgres:',
    '    ports:',
    '      - "127.0.0.1:5433:5432"',
  ].join('\n');

  assert.doesNotThrow(() => assertLoopbackOnly(compliant), 'the compliant single-service shape must pass');

  for (const [shape, second] of [
    ['block form', ['  adminer:', '    ports:', '      - "0.0.0.0:8080:8080"']],
    ['inline flow form', ['  adminer:', '    ports: ["0.0.0.0:8080:8080"]']],
    ['long form it cannot read', ['  adminer:', '    ports:', '      - target: 8080', '        published: 8080']],
    ['empty inline list', ['  adminer:', '    ports: []']],
  ]) {
    assert.throws(
      () => assertLoopbackOnly([compliant, ...second].join('\n')),
      assert.AssertionError,
      `a second service in ${shape} must turn the row red even though the first service is compliant`,
    );
  }
});
