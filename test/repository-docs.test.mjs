import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const architecturePath = resolve(projectRoot, 'docs/incident-commander-architecture-v1.md');
const formerArchitecturePath = resolve(projectRoot, 'incident-commander-architecture-v1.md');
const readmePath = resolve(projectRoot, 'README.md');
const journalPath = resolve(projectRoot, 'journal/2026-08.md');

test('keeps the architecture brief at its canonical docs path', () => {
  assert.equal(existsSync(architecturePath), true);
  assert.equal(existsSync(formerArchitecturePath), false);
});

test('links the root README to the canonical architecture brief', () => {
  assert.equal(existsSync(readmePath), true);
  const readme = readFileSync(readmePath, 'utf8');
  assert.match(readme, /\[Architecture v1\]\(docs\/incident-commander-architecture-v1\.md\)/);
});

test('describes planned product behavior as design while implementation has not started', () => {
  const readme = readFileSync(readmePath, 'utf8');
  assert.match(readme, /AI Incident Commander is designed as a stateful investigation system/);
  assert.match(readme, /\| Product implementation \| Not started \|/);
});

test('records the latest Jira adapter stop without claiming the issue', () => {
  const journal = readFileSync(journalPath, 'utf8');
  assert.match(journal, /### Jira connector reachable; adapter still missing shell credentials/);
  assert.match(journal, /AIC-2 remained `To Do` and unclaimed/);
  assert.match(journal, /\*\*stopped at\*\* — `queue-unreadable`/);
});
