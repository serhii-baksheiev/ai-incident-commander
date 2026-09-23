import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The repository is meant to be readable by strangers. Two kinds of residue do
 * not survive that: links into the private issue-tracker site (a login wall that
 * also assumes access the reader does not have), and a personal macOS home path.
 * The AIC-N identifiers stay — they are engineering history; only the private
 * host goes.
 *
 * Both patterns are ASSEMBLED rather than written out, because this file is a
 * tracked text file and scans itself: a literal example here would be reported
 * as its own violation.
 */
const TRACKER_HOST_SUFFIX = ['atlassian', 'net'].join('\\.');
const PRIVATE_TRACKER_LINK = new RegExp(
  `https?://([a-z0-9-]+)\\.${TRACKER_HOST_SUFFIX}`,
  'gi',
);
/** The documented placeholder in the queue adapter's usage comment is portable, not private. */
const PLACEHOLDER_SUBDOMAIN = 'your-site';
const PERSONAL_HOME_PATH = new RegExp(`/${'Users'}/[A-Za-z][^/\\s]*`, 'g');

const BINARY_SNIFF_BYTES = 8192;

/** Every tracked regular text file, as `{ path, lines }`. */
function trackedTextFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: childEnv(),
  });
  assert.equal(result.status, 0, `git ls-files failed: ${result.stderr}`);
  const paths = result.stdout.split('\0').filter(Boolean);
  assert.ok(paths.length > 0, 'git ls-files must list the tracked tree');

  const files = [];
  for (const path of paths) {
    const absolute = resolve(projectRoot, path);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      continue; // tracked but deleted in this checkout: it carries nothing
    }
    if (!stat.isFile()) continue;
    const bytes = readFileSync(absolute);
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue;
    files.push({ path, lines: bytes.toString('utf8').split('\n') });
  }
  return files;
}

function violations(files, findOffenders) {
  const found = [];
  for (const { path, lines } of files) {
    lines.forEach((line, index) => {
      for (const offender of findOffenders(line)) {
        found.push(`${path}:${index + 1}: ${offender}`);
      }
    });
  }
  return found;
}

test('no tracked text file links a private Atlassian site', () => {
  const found = violations(trackedTextFiles(), (line) =>
    [...line.matchAll(PRIVATE_TRACKER_LINK)]
      .filter((match) => match[1].toLowerCase() !== PLACEHOLDER_SUBDOMAIN)
      .map((match) => match[0]),
  );
  assert.deepEqual(
    found,
    [],
    `private issue-tracker links found (keep the AIC-N id, drop the link):\n${found.join('\n')}`,
  );
});

test('no tracked text file carries a personal macOS home-directory path', () => {
  const found = violations(trackedTextFiles(), (line) =>
    [...line.matchAll(PERSONAL_HOME_PATH)].map((match) => match[0]),
  );
  assert.deepEqual(
    found,
    [],
    `personal home-directory paths found:\n${found.join('\n')}`,
  );
});
