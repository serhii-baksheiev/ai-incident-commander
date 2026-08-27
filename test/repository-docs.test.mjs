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

test('describes planned product behavior as design and points to the next domain milestone', () => {
  const readme = readFileSync(readmePath, 'utf8');
  assert.match(readme, /AI Incident Commander is designed as a stateful investigation system/);
  assert.match(
    readme,
    /\| Next implementation milestone \| \[AIC-3 — canonical domain types and IncidentState\]/,
  );
});

test('records the latest Jira adapter stop without claiming the issue', () => {
  const journal = readFileSync(journalPath, 'utf8');
  assert.match(journal, /### Jira connector reachable; adapter still missing shell credentials/);
  assert.match(journal, /AIC-2 remained `To Do` and unclaimed/);
  assert.match(journal, /native Jira link currently makes AIC-2 blocked by AIC-3/);
  assert.match(journal, /\*\*stopped at\*\* — `queue-unreadable`/);
});

test('records the final AIC-2 gate stop in the newest journal entry', () => {
  const journal = readFileSync(journalPath, 'utf8');
  const [, newestEntry] = journal.split(/^### /m);

  assert.match(newestEntry, /^AIC-2 escalated after final boundary gate; dependent Jira queue held$/m);
  assert.match(newestEntry, /AIC-2[^\n]*`documented-stall`/);
  assert.match(newestEntry, /gate round 2\/2/);
  assert.match(newestEntry, /\b8c2072d5ff13378c845bbeafbfcc6b3db16d2b62\b/);
  assert.match(newestEntry, /\*\*stopped at\*\* — `nothing-selectable`/);
  assert.match(newestEntry, /AIC-3 remains blocked by AIC-2/);
  assert.match(newestEntry, /AIC-51 remains `operator-queue`\/`triage`/);
  assert.match(newestEntry, /AIC-52 is `Done`/);
  assert.match(newestEntry, /\*\*run evidence\*\*[^\n]*`\.claude\/runs\/20260827-aic2-delivery`/);
});

test('preserves the shipped runner PR and exact CI evidence in its historical entry', () => {
  const journal = readFileSync(journalPath, 'utf8');
  const runnerEntry = journal
    .split(/^### /m)
    .find((entry) =>
      entry.startsWith('Isolated self-hosted runner shipped; Jira loop stopped on unchanged reversed links'),
    );

  assert.notEqual(runnerEntry, undefined, 'the shipped runner journal entry must remain present');
  assert.match(runnerEntry, /\bPR #6\b/);
  assert.match(runnerEntry, /\bd0ad96074a416261c9d8238a7651d8b582b13a75\b/);
  assert.match(runnerEntry, /exact-head run `33008181354`/);
  assert.match(runnerEntry, /post-merge run `33008628082`/);
  assert.match(runnerEntry, /AIC-52[^\n]*`Done`/);
  assert.match(runnerEntry, /\*\*stopped at\*\* — `queue-data-anomaly`/);
  assert.match(runnerEntry, /AIC-51[^\n]*`14669`/);
});
