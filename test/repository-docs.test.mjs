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

test('records the completed domain milestone and the persistent checkpointer as next', () => {
  const readme = readFileSync(readmePath, 'utf8');
  assert.match(readme, /AI Incident Commander is designed as a stateful investigation system/);
  assert.match(
    readme,
    /\| Product implementation \| [^|\n]*canonical domain contracts[^|\n]*implemented[^|\n]*\|/i,
  );
  assert.match(
    readme,
    /\| Completed implementation milestone \| \[AIC-3[^\]]*canonical domain types and IncidentState\]\(https:\/\/sbaksheiev\.atlassian\.net\/browse\/AIC-3\) \|/i,
  );
  assert.match(
    readme,
    /\| Next implementation milestone \| \[AIC-4[^\]]*persistent[^\]]*checkpointer[^\]]*\]\(https:\/\/sbaksheiev\.atlassian\.net\/browse\/AIC-4\) \|/i,
  );
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

test('records the completed AIC-2 delivery before the preserved layered-boundary hold', () => {
  const journal = readFileSync(journalPath, 'utf8');
  const entries = journal.split(/^### /m).slice(1);
  const deliveryIndex = entries.findIndex((entry) =>
    entry.startsWith('AIC-2 delivered; first implementation milestone unblocked'),
  );
  assert.notEqual(deliveryIndex, -1, 'the completed AIC-2 delivery must remain present');
  const deliveryEntry = entries[deliveryIndex];
  const layeredHoldEntry = entries[deliveryIndex + 1];

  assert.match(deliveryEntry, /^AIC-2 .*?(?:completed|delivered|shipped).*$/mi);
  assert.match(deliveryEntry, /\bPR #12\b/);
  assert.match(deliveryEntry, /\b2bed4f019cce9b448cc38daf6d1d3b896c9d9c7d\b/);
  assert.match(
    deliveryEntry,
    /exact-head post-merge CI run `33088043337`[^\n]*(?:success|succeeded)/i,
  );
  assert.match(deliveryEntry, /AIC-2[^\n]*`Done`/);
  assert.match(deliveryEntry, /AIC-3[^\n]*unblocked[^\n]*`To Do`/i);
  assert.match(
    layeredHoldEntry,
    /^AIC-2 layered-boundary retry held and escalated at architecture review$/m,
  );

  const historicalMarker = '### AIC-2 layered-boundary retry held and escalated at architecture review';
  const historicalOffset = journal.indexOf(historicalMarker);
  const historicalJournal = journal.slice(historicalOffset);
  assert.equal(
    createHash('sha256').update(historicalJournal).digest('hex'),
    '099241784f51508256c57f6c213135afcaddb884026893331fe48cda5d2a94e7',
    'the prior layered-boundary hold and all older journal history must remain byte-for-byte',
  );
});

test('records the continuous Rovo repeated-escalation stop before preserving the existing journal body', () => {
  const journal = readFileSync(journalPath, 'utf8');
  const [, newestEntry] = journal.split(/^### /m);
  const requiredEvidence = [
    {
      label: 'records the repeated-escalation stop',
      pattern: /\*\*stopped at\*\* — `repeated-escalation`/,
    },
    {
      label: 'parks AIC-4 at the pushed head pending exact owner dependency approval',
      pattern:
        /AIC-4[^\n]*parked[^\n]*pushed head `3d5e03e9bf3bb168bcde73091ec20c90b173542d`[^\n]*await(?:ing|s)[^\n]*exact owner approval[^\n]*`@langchain\/langgraph@1\.4\.13`[^\n]*`@langchain\/langgraph-checkpoint@1\.1\.5`[^\n]*`@langchain\/langgraph-checkpoint-sqlite@1\.0\.4`[^\n]*transitive[^\n]*`better-sqlite3@12\.11\.1`/i,
    },
    {
      label: 'parks AIC-5 at the pushed head after its final split gate verdict',
      pattern:
        /AIC-5[^\n]*parked[^\n]*pushed head `7aba0e51de42a2464eff92d4921585a947ed5a72`[\s\S]*final pr-ship round 2\/2[^\n]*code `SHIP`[^\n]*prose `SHIP`[^\n]*security `HOLD`[^\n]*verbatim[^\n]*caught exception messages/i,
    },
    {
      label: 'records that no PR or merge occurred',
      pattern: /no PR was opened[^\n]*(?:nothing was merged|no merge)/i,
    },
    { label: 'records that nothing was unblocked', pattern: /nothing was unblocked/i },
    {
      label: 'pins both Rovo comments',
      pattern:
        /(?:Rovo comment `14840`[\s\S]*Rovo comment `14843`|Rovo comments? `14840`[^\n]*`14843`)/i,
    },
    {
      label: 'pins the continuous Rovo run evidence',
      pattern: /`\.claude\/runs\/20260827-223620-continuous-rovo`/,
    },
  ];
  const problems = requiredEvidence
    .filter(({ pattern }) => !pattern.test(newestEntry))
    .map(({ label }) => label);

  const historicalMarker = '### AIC-3 delivered; canonical domain contracts unblocked graph work';
  const historicalOffset = journal.indexOf(historicalMarker);
  const historicalJournal = journal.slice(historicalOffset);
  if (
    createHash('sha256').update(historicalJournal).digest('hex') !==
    'f764a5258edbb263da6b4634f98a05f8bc4e9c99c0a2ba54d2bd54c4c01eb624'
  ) {
    problems.push('must preserve the entire existing journal body byte-for-byte after the new entry');
  }

  assert.deepEqual(problems, []);
});

test('records the completed AIC-3 delivery before preserving the existing journal body', () => {
  const journal = readFileSync(journalPath, 'utf8');
  const [, ...entries] = journal.split(/^### /m);
  const deliveryEntry = entries.find((entry) =>
    entry.startsWith('AIC-3 delivered; canonical domain contracts unblocked graph work'),
  );
  assert.notEqual(deliveryEntry, undefined, 'the completed AIC-3 delivery entry must remain present');
  const requiredEvidence = [
    {
      label: 'uses a delivered AIC-3 heading',
      pattern: /^AIC-3 .*?(?:completed|delivered|shipped).*$/mi,
    },
    {
      label: 'pins PR #16 and its merge SHA',
      pattern: /\bPR #16\b[\s\S]*\b81c2d945d7fabf23ccecee5576a1bf5fcaef1bfe\b/,
    },
    {
      label: 'pins the successful exact-head post-merge CI run',
      pattern: /exact-head post-merge CI run `33101999211`[^\n]*(?:success|succeeded)/i,
    },
    {
      label: 'records AIC-3 as Done with resolution Done',
      pattern: /AIC-3[^\n]*`Done`[^\n]*resolution `Done`/i,
    },
    {
      label: 'records all fresh exact-head reviewer verdicts',
      pattern: /fresh exact-head[^\n]*code `SHIP`[^\n]*prose `SHIP`[^\n]*security `SHIP`/i,
    },
    {
      label: 'records the unchanged closed probe scope',
      pattern:
        /exactly (?:eight|8) (?:top-level )?probes[^\n]*dependency-value[^\n]*(?:did not expand|unchanged)/i,
    },
    { label: 'records that no deploy occurred', pattern: /(?:no deploy|deploys: 0)/i },
    {
      label: 'records that AIC-3 no longer blocks AIC-4 through AIC-7',
      pattern: /AIC-3[^\n]*no longer blocks[^\n]*AIC-4[^\n]*AIC-7/i,
    },
    {
      label: 'records only AIC-4 and AIC-5 as globally unblocked and To Do',
      pattern: /only AIC-4 and AIC-5[^\n]*globally unblocked[^\n]*`To Do`/i,
    },
    {
      label: 'records AIC-6 as blocked by To Do AIC-5',
      pattern: /AIC-6[^\n]*blocked by[^\n]*`To Do` AIC-5/i,
    },
    {
      label: 'records AIC-7 as blocked by To Do AIC-6',
      pattern: /AIC-7[^\n]*blocked by[^\n]*`To Do` AIC-6/i,
    },
    {
      label: 'records the local adapter hold and unchanged live Rovo action',
      pattern:
        /local plan-md `BEFORE_CLOSE`[^\n]*held[^\n]*live Rovo re-read[^\n]*action unchanged/i,
    },
    {
      label: 'records only observed reviewer, CI, and deploy costs',
      pattern: /reviewer subagent runs: 3; CI runs: 2[^\n]*deploys: 0/i,
    },
    {
      label: 'pins the fresh run and Jira completion comment',
      pattern:
        /`\.claude\/runs\/20260827-aic3-fresh-gate-audit`[^\n]*Jira comment `14835`[^\n]*correction comment `14836`[^\n]*supersedes only the broad unblocking sentence/i,
    },
  ];
  const problems = requiredEvidence
    .filter(({ pattern }) => !pattern.test(deliveryEntry))
    .map(({ label }) => label);

  if (/test-writer(?: subagents?)?(?: runs)?:\s*\d/i.test(deliveryEntry)) {
    problems.push('must not invent a test-writer count');
  }
  if (/AIC-4 through AIC-7 are (?:globally )?unblocked/i.test(deliveryEntry)) {
    problems.push('must not claim that all AIC-4 through AIC-7 are globally unblocked');
  }

  const historicalMarker = '### AIC-2 delivered; first implementation milestone unblocked';
  const historicalOffset = journal.indexOf(historicalMarker);
  const historicalJournal = journal.slice(historicalOffset);
  if (
    createHash('sha256').update(historicalJournal).digest('hex') !==
    '60cf9666abce33493ae89c77558b3d5dff8bb289c0b27b7e5ac24b14facccb7a'
  ) {
    problems.push('must preserve the entire existing journal body byte-for-byte');
  }

  assert.deepEqual(problems, []);
});

test('preserves the AIC-2 layered-boundary retry hold in its historical journal entry', () => {
  const journal = readFileSync(journalPath, 'utf8');
  const [, ...entries] = journal.split(/^### /m);
  const newestEntry = entries.find((entry) =>
    entry.startsWith('AIC-2 layered-boundary retry held and escalated at architecture review'),
  );
  assert.notEqual(newestEntry, undefined, 'the layered-boundary HOLD must remain present');
  const requiredEvidence = [
    {
      label: 'uses an AIC-2 layered-boundary retry heading',
      pattern: /^AIC-2 layered-boundary retry.*(?:held|escalated).*$/mi,
    },
    {
      label: 'records HOLD and escalation at the exact head',
      pattern:
        /(?:HOLD[\s\S]*escalat|escalat[\s\S]*HOLD)[\s\S]*0b1caa43de290c53253b587975b74e4f5f6f118e/i,
    },
    { label: 'records owner ruling comment 14724', pattern: /Jira comment `14724`/ },
    {
      label: 'points to comment 14759 as the durable TDD and validation source',
      pattern: /Jira comment `14759`.*durable source.*(?:TDD|validation)/i,
    },
    {
      label: 'records the blocking npm alias regex finding',
      pattern:
        /(?:block(?:er|ing)?.*npm[ -]alias.*(?:regex|regular expression)|npm[ -]alias.*(?:regex|regular expression).*block)/i,
    },
    { label: 'records that no PR was opened', pattern: /no PR was opened/i },
    { label: 'records that nothing was merged', pattern: /nothing was merged/i },
    { label: 'records that no pr-ship round ran', pattern: /no.*pr-ship.*round/i },
    {
      label: 'records the preserved remote branch and worktree',
      pattern:
        /remote branch `fix\/aic-2-layered-boundaries`[\s\S]*worktree.*(?:preserv|remain)/i,
    },
    { label: 'stops on the budget rule', pattern: /\*\*stopped at\*\* — `budget`/ },
    {
      label: 'does not estimate agent, CI, or deploy counts absent from durable state',
      pattern:
        /\*\*cost\*\* — .*exact earlier (?:agent\/CI\/deploy|agent, CI, and deploy) counts.*not retained in durable run state.*not estimated/i,
    },
  ];
  const problems = requiredEvidence
    .filter(({ pattern }) => !pattern.test(newestEntry))
    .map(({ label }) => label);

  if (/(?:14 failed|14\/14|34\/34|npm audit|install.*scripts)/i.test(newestEntry)) {
    problems.push('must leave TDD, audit, and install-script measurements in Jira comment 14759');
  }

  const costLine = newestEntry.match(/^- \*\*cost\*\* — .*$/m)?.[0] ?? '';
  if (/\d/.test(costLine)) {
    problems.push('must not invent numeric agent, CI, or deploy costs');
  }

  assert.deepEqual(problems, []);
});

test('preserves the Agent Rig refresh final gate hold in its historical journal entry', () => {
  const journal = readFileSync(journalPath, 'utf8');
  const [, ...entries] = journal.split(/^### /m);
  const entryIndex = entries.findIndex((entry) => entry.startsWith('Agent Rig refresh held at final gate'));
  const newestEntry = entries[entryIndex];
  assert.notEqual(entryIndex, -1, 'the Agent Rig refresh entry must remain present');
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
      label: 'distinguishes durable gate inputs from the final pr-ship aggregate',
      pattern:
        /durable gate input reports: 4 \(1 premise, 3 reviewers\); final pr-ship aggregate report: 1; exact test-writer\/subagent turn count was not retained and is not estimated; CI runs: 0; deploys: 0/,
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
  if (/durable gate reports:\s*4\b/i.test(newestEntry)) {
    problems.push('must not conflate gate inputs with the final pr-ship aggregate');
  }

  const historicalMarker = '### Agent Rig refresh held at final gate';
  const historicalOffset = journal.indexOf(historicalMarker);
  const historicalJournal = journal.slice(historicalOffset);
  const historicalHash = createHash('sha256').update(historicalJournal).digest('hex');
  if (historicalHash !== '7b6be138bf75d48c4ee629f7ab7d30689c2992c5ebb9f2340419f8bddb529f9a') {
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
