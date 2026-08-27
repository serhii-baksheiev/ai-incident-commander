import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  assert.match(journal, /native Jira link currently makes AIC-2 blocked by AIC-3/);
  assert.match(journal, /\*\*stopped at\*\* — `queue-unreadable`/);
});

test('preserves the first final AIC-2 gate stop in its historical journal entry', () => {
  const journal = readFileSync(journalPath, 'utf8');
  const historicalEntry = journal
    .split(/^### /m)
    .find((entry) =>
      entry.startsWith('AIC-2 escalated after final boundary gate; dependent Jira queue held'),
    );

  assert.notEqual(historicalEntry, undefined, 'the first final AIC-2 gate stop must remain present');
  assert.match(historicalEntry, /AIC-2[^\n]*`documented-stall`/);
  assert.match(historicalEntry, /gate round 2\/2/);
  assert.match(historicalEntry, /\b8c2072d5ff13378c845bbeafbfcc6b3db16d2b62\b/);
  assert.match(historicalEntry, /\*\*stopped at\*\* — `nothing-selectable`/);
  assert.match(historicalEntry, /AIC-3 remains blocked by AIC-2/);
  assert.match(historicalEntry, /AIC-51 remains `operator-queue`\/`triage`/);
  assert.match(historicalEntry, /AIC-52 is `Done`/);
  assert.match(
    historicalEntry,
    /\*\*run evidence\*\*[^\n]*`\.claude\/runs\/20260827-aic2-delivery`/,
  );
});

test('preserves the final AIC-2 retry gate stop in its historical journal entry', () => {
  const journal = readFileSync(journalPath, 'utf8');
  const retryEntry = journal
    .split(/^### /m)
    .find((entry) =>
      entry.startsWith('AIC-2 retry escalated after final AST gate; native Jira queue held'),
    );

  assert.notEqual(retryEntry, undefined, 'the final AIC-2 retry entry must remain present');
  assert.match(retryEntry, /^AIC-2 retry[^\n]*$/m);
  assert.match(retryEntry, /AIC-2[^\n]*`documented-stall`/);
  assert.match(retryEntry, /gate round 2\/2/);
  assert.match(retryEntry, /pushed head `516044f32a8e402edff7fd404dd835e72111878c`/);
  assert.match(retryEntry, /Jira comment `14722`/);
  assert.match(retryEntry, /prose `SHIP`[^\n]*code `HOLD`[^\n]*security `HOLD`/);
  assert.match(retryEntry, /no PR was opened and nothing was merged/);
  assert.match(retryEntry, /\*\*stopped at\*\* — `nothing-selectable`/);
  assert.match(retryEntry, /43 blocked implementation tasks/);
  assert.match(retryEntry, /AIC-2[^\n]*(?:parked[^\n]*escalated|escalated[^\n]*parked)/);
  assert.match(retryEntry, /AIC-3 remains blocked by AIC-2/);
  assert.match(retryEntry, /deployment object `6116833287`/);
  assert.match(retryEntry, /no status[^\n]*no workflow run/);
  assert.match(retryEntry, /deployment API objects created: 1[^\n]*deploy executions: 0/);
});

test('records the Agent Rig refresh final gate hold in the newest journal entry', () => {
  const journal = readFileSync(journalPath, 'utf8');
  const [, newestEntry, ...historicalEntries] = journal.split(/^### /m);
  const requiredEvidence = [
    {
      label: 'uses the exact final-gate heading',
      pattern: /^Agent Rig refresh held at final gate$/m,
    },
    {
      label: 'pins the product branch and exact head',
      pattern:
        /product branch `chore\/update-agent-rig-components`[^\n]*`61ad0535214623c02eb1efebdfc0c71cd3505f5f`/,
    },
    {
      label: 'pins the GitHub upstream generator head and package version',
      pattern:
        /GitHub upstream generator[^\n]*`0bdb6b18232703f1d600e7fcfd0afbefaa5228ff`[^\n]*package version `0\.6\.0`/,
    },
    {
      label: 'records the final pr-ship verdict',
      pattern: /pr-ship round 2\/2[^\n]*`HOLD`/,
    },
    {
      label: 'records code exact-head coverage',
      pattern: /(?:code[^\n]*exact-head coverage|exact-head coverage[^\n]*code)/i,
    },
    {
      label: 'records prose exact-head coverage',
      pattern: /(?:prose[^\n]*exact-head coverage|exact-head coverage[^\n]*prose)/i,
    },
    {
      label: 'records security exact-head coverage',
      pattern: /(?:security[^\n]*exact-head coverage|exact-head coverage[^\n]*security)/i,
    },
    {
      label: 'records Codex rulebook authorization omissions',
      pattern: /Codex rulebook authorization omissions/i,
    },
    {
      label: 'records the global unattended-flag collision',
      pattern: /global unattended-flag collision/i,
    },
    {
      label: 'records board-name terminal injection',
      pattern: /board-name terminal injection/i,
    },
    {
      label: 'records locally dead test pointers',
      pattern: /locally dead test pointers/i,
    },
    {
      label: 'records all local tests passing',
      pattern: /local[^\n]*27\/27|27\/27[^\n]*local/i,
    },
    {
      label: 'records doctor GO',
      pattern: /doctor[^\n]*`GO`/i,
    },
    {
      label: 'does not claim Windows runtime coverage',
      pattern: /(?:no Windows runtime|Windows runtime[^\n]*(?:unavailable|not run|not executed))/i,
    },
    {
      label: 'records that no PR or merge occurred',
      pattern: /no PR was opened and nothing was merged/,
    },
    {
      label: 'records the preserved remote branch and worktree',
      pattern:
        /remote branch `chore\/update-agent-rig-components`[^\n]*worktree[^\n]*preserved/i,
    },
    {
      label: 'pins the prior run evidence',
      pattern: /`\.claude\/runs\/20260827-rig-update-resume`/,
    },
    {
      label: 'records only the durable gate-report cost and does not estimate turn count',
      pattern:
        /durable gate reports: 4 \(1 premise, 3 reviewers\); exact test-writer\/subagent turn count was not retained and is not estimated; CI runs: 0; deploys: 0/,
    },
  ];
  const problems = requiredEvidence
    .filter(({ pattern }) => !pattern.test(newestEntry))
    .map(({ label }) => label);

  if (/(?:published[- ]tarball|npm publish|npm registry)/i.test(newestEntry)) {
    problems.push('must attribute 0.6.0 to the GitHub generator head, not a published tarball');
  }
  if (/(?:test-writer subagents:\s*1|premise\/reviewer subagents:\s*4)/i.test(newestEntry)) {
    problems.push('must not present an inferred subagent count as durable evidence');
  }

  const historicalJournal = historicalEntries.join('### ');
  const historicalHash = createHash('sha256').update(historicalJournal).digest('hex');
  if (historicalHash !== '38a57ec622f257bf129381ce4b7f21da0230cbaabfa9d8a066fab070e2eac4b1') {
    problems.push('must preserve the prior journal history byte-for-byte after the new entry');
  }

  assert.deepEqual(problems, []);
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
