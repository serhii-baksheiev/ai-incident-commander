import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The CI contract for a PUBLIC repository. Every pull request can come from an
// untrusted contributor, so ordinary PR validation runs on a disposable
// GitHub-hosted runner with a read-only token, no secrets, and no expression
// that splices contributor-controlled text into a shell. The workflow is read
// as text on purpose: no YAML dependency is installed, and the checks below are
// line-shaped enough not to need one.

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(projectRoot, '.github/workflows/ci.yml');
const readmePath = resolve(projectRoot, 'README.md');
const runnerGuidePath = resolve(projectRoot, 'RUNNER.md');
const runnerDirectoryPath = resolve(projectRoot, '.github/runner');

const HOSTED_RUNNER = 'ubuntu-24.04';

function readRequired(path, message) {
  assert.equal(existsSync(path), true, message);
  return readFileSync(path, 'utf8');
}

function readWorkflow() {
  return readRequired(workflowPath, '.github/workflows/ci.yml must define the repository CI contract');
}

function indentOf(line) {
  return line.match(/^\s*/)[0].length;
}

function isComment(line) {
  return /^\s*#/.test(line);
}

// The lines of a mapping block that starts at `headerIndex`: every following
// line indented deeper than the header, stopping at the first one that is not.
function blockBody(lines, headerIndex) {
  const headerIndent = indentOf(lines[headerIndex]);
  const body = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.trim() !== '' && !isComment(line) && indentOf(line) <= headerIndent) break;
    body.push(line);
  }
  return body;
}

// The keys directly under a top-level mapping (`on:`, `permissions:`, `jobs:`),
// each with the lines of its own block.
function topLevelBlock(workflow, key) {
  const lines = workflow.split('\n');
  const headerIndex = lines.findIndex((line) => new RegExp(`^${key}:\\s*(?:#.*)?$`).test(line));
  if (headerIndex === -1) return null;
  const body = blockBody(lines, headerIndex);
  const childIndent = Math.min(
    ...body.filter((line) => line.trim() !== '' && !isComment(line)).map(indentOf),
  );
  const children = new Map();
  body.forEach((line, index) => {
    if (line.trim() === '' || isComment(line) || indentOf(line) !== childIndent) return;
    const name = line.trim().match(/^([^:\s]+):/)?.[1];
    if (name === undefined) return;
    children.set(name, blockBody(body, index));
  });
  return children;
}

function extractJobs(workflow) {
  const jobs = topLevelBlock(workflow, 'jobs');
  assert.notEqual(jobs, null, 'workflow must define a top-level jobs: block');
  assert.equal(jobs.size > 0, true, 'workflow must define at least one job');
  return jobs;
}

// Every `run:` script, in file order: both the single-line form
// (`run: npm test`, `- run: npm test`) and block scalars (`run: |`, `run: >-`),
// whose body is every following line indented deeper than the `run:` key.
function extractRunScripts(workflow) {
  const lines = workflow.split('\n');
  const scripts = [];
  lines.forEach((line, index) => {
    const match = line.match(/^(\s*(?:-\s+)?)run:\s*(.*?)\s*$/);
    if (match === null || isComment(line)) return;
    const keyColumn = match[1].length;
    const value = match[2];
    if (/^[|>][+-]?\d*\s*(?:#.*)?$/.test(value)) {
      const body = [];
      for (const bodyLine of lines.slice(index + 1)) {
        if (bodyLine.trim() !== '' && indentOf(bodyLine) <= keyColumn) break;
        body.push(bodyLine.trim());
      }
      scripts.push(body.join('\n').trim());
    } else {
      scripts.push(value.replace(/^(['"])(.*)\1$/, '$2'));
    }
  });
  return scripts;
}

const UNTRUSTED_EXPRESSION = /\$\{\{[^}]*\b(?:github\.event\.|github\.head_ref\b)/;

test('the run-script reader sees single-line and literal-block scripts, so the injection guard is not vacuous', () => {
  const synthetic = [
    'jobs:',
    '  checks:',
    '    steps:',
    '      - run: echo one',
    '      - name: block',
    '        run: |',
    '          echo "${{ github.event.pull_request.title }}"',
    '          echo two',
    '      - name: folded',
    '        run: >-',
    '          echo ${{ github.head_ref }}',
    '      - name: after',
    '        run: "npm test"',
  ].join('\n');

  const scripts = extractRunScripts(synthetic);
  assert.deepEqual(
    scripts,
    [
      'echo one',
      'echo "${{ github.event.pull_request.title }}"\necho two',
      'echo ${{ github.head_ref }}',
      'npm test',
    ],
    'the reader must return every run script whole, or an injected expression in a block ' +
      'scalar passes the guard unseen',
  );
  assert.deepEqual(
    scripts.map((script) => UNTRUSTED_EXPRESSION.test(script)),
    [false, true, true, false],
    'the injection pattern must flag github.event.* and github.head_ref inside a run script',
  );
});

test('triggers only on pull_request and on pushes to main, never on a privileged event', () => {
  const workflow = readWorkflow();
  const triggers = topLevelBlock(workflow, 'on');

  assert.notEqual(
    triggers,
    null,
    'the workflow must declare its triggers as a top-level `on:` block, so the trigger set is ' +
      'readable line by line',
  );
  assert.deepEqual(
    [...triggers.keys()].sort(),
    ['pull_request', 'push'],
    'a public repository runs ordinary CI on pull_request and push only: any other event widens ' +
      'who can start a run, and with what token',
  );
  assert.match(
    workflow,
    /^\s{2}pull_request:\s*$/m,
    'pull_request must run for every PR, so an untrusted contribution is validated before review',
  );
  assert.match(
    triggers.get('push').join('\n'),
    /^\s{4}branches:\s*\[\s*main\s*\]\s*$/m,
    'push CI must be limited to main, the branch the repository releases from',
  );
  for (const privileged of ['pull_request_target', 'workflow_run', 'issue_comment']) {
    assert.doesNotMatch(
      workflow,
      new RegExp(`\\b${privileged}\\b`),
      `${privileged} runs with the base repository's token and secrets on attacker-influenced ` +
        'input; a public repository must not use it for ordinary CI',
    );
  }
});

test('every job runs on the pinned GitHub-hosted ubuntu-24.04 image and nothing else', () => {
  const workflow = readWorkflow();
  const jobs = extractJobs(workflow);

  for (const [name, body] of jobs) {
    const runsOn = body.filter((line) => /^\s*runs-on:/.test(line));
    assert.deepEqual(
      runsOn.map((line) => line.trim()),
      [`runs-on: ${HOSTED_RUNNER}`],
      `job ${name} must run on exactly \`${HOSTED_RUNNER}\`: a public repository's PRs must never ` +
        'reach a privately operated self-hosted machine, and a pinned image keeps CI reproducible',
    );
  }
  assert.doesNotMatch(
    workflow,
    /self-hosted/,
    'no job may target a self-hosted runner: untrusted PR code would execute on private hardware',
  );
  assert.doesNotMatch(
    workflow,
    /\b(?:ubuntu|windows|macos)-latest\b/i,
    'a `-latest` image moves under the repository without a commit; pin the image version',
  );
});

test('grants the token contents: read only, at the top level, with no job widening it', () => {
  const workflow = readWorkflow();
  const permissions = topLevelBlock(workflow, 'permissions');

  assert.notEqual(
    permissions,
    null,
    'the workflow must declare top-level permissions, or the token gets the repository default',
  );
  assert.deepEqual(
    [...permissions.keys()],
    ['contents'],
    'the CI token must carry exactly one scope, contents, because PR validation only reads code',
  );
  assert.match(
    workflow,
    /^permissions:\s*\n\s{2}contents:\s*read\s*$/m,
    'the contents scope must be read: a PR from an untrusted contributor must not be able to write',
  );
  assert.doesNotMatch(workflow, /write-all/, 'write-all hands every scope to untrusted PR code');
  assert.doesNotMatch(
    workflow,
    /:[ \t]*write\b/,
    'no scope anywhere in the workflow may be write: untrusted PR code runs with this token',
  );
  assert.doesNotMatch(
    workflow,
    /^[ \t]+permissions:/m,
    'no job may declare its own permissions: a job-level block can silently widen the top-level one',
  );
});

test('cancels superseded runs in one concurrency group per workflow and ref', () => {
  const workflow = readWorkflow();

  assert.match(workflow, /^concurrency:\s*$/m, 'the workflow must declare a concurrency group');
  assert.match(
    workflow,
    /^\s{2}group:\s*.*github\.workflow.*github\.ref.*$/m,
    'the concurrency group must be keyed on workflow and ref, so pushes to one PR queue together',
  );
  assert.match(
    workflow,
    /^[ \t]{2}cancel-in-progress:[ \t]*(?!false[ \t]*$)\S.*$/m,
    'superseded runs must be cancellable, so a burst of PR pushes cannot pile up hosted minutes',
  );
});

test('every job has an explicit timeout of at most 30 minutes', () => {
  const jobs = extractJobs(readWorkflow());

  for (const [name, body] of jobs) {
    const timeouts = body
      .map((line) => line.match(/^\s{4}timeout-minutes:\s*(\d+)\s*$/)?.[1])
      .filter((value) => value !== undefined)
      .map(Number);
    assert.equal(
      timeouts.length,
      1,
      `job ${name} needs an explicit timeout-minutes, or a hung PR run holds a runner for six hours`,
    );
    assert.equal(
      timeouts[0] > 0 && timeouts[0] <= 30,
      true,
      `job ${name} timeout must be positive and no longer than 30 minutes, got ${timeouts[0]}`,
    );
  }
});

test('pins every action to a full 40-character commit SHA', () => {
  const workflow = readWorkflow();
  const uses = workflow
    .split('\n')
    .filter((line) => !isComment(line))
    .map((line) => line.match(/^\s*(?:-\s+)?uses:\s*(\S+?)\s*(?:#.*)?$/)?.[1])
    .filter((value) => value !== undefined);

  assert.equal(uses.length > 0, true, 'the workflow must use at least checkout and setup-node');
  const unpinned = uses.filter((ref) => !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref));
  assert.deepEqual(
    unpinned,
    [],
    'every `uses:` must be pinned to a 40-hex commit SHA: a tag or branch can be moved to code ' +
      'the repository never reviewed, and it would run on every PR',
  );
});

test('checks out without persisting credentials before setting up node', () => {
  const workflow = readWorkflow();

  assert.match(
    workflow,
    /^\s+- uses:\s*actions\/checkout@[0-9a-f]{40}\s*(?:#.*)?$/im,
    'the workflow must check out with a SHA-pinned actions/checkout',
  );
  assert.match(
    workflow,
    /actions\/checkout@[0-9a-f]{40}[\s\S]*?persist-credentials:\s*false[\s\S]*?actions\/setup-node@[0-9a-f]{40}/i,
    'checkout must set persist-credentials: false, so the token is not left in .git/config for ' +
      'the untrusted PR code (npm scripts, tests) that runs after it',
  );
});

test('references no secret or token, because ordinary PR validation needs none', () => {
  const workflow = readWorkflow();

  assert.doesNotMatch(
    workflow,
    /\bsecrets\s*(?:\.|\[|:)/,
    'the workflow must not reference secrets: CI on a public repository runs untrusted PR code, ' +
      'and ordinary validation (install, lint, build, test) needs no credential',
  );
  assert.doesNotMatch(
    workflow,
    /\bgithub\.token\b/,
    'the workflow must not hand github.token to a step: it is the same credential as ' +
      'secrets.GITHUB_TOKEN under another name',
  );
});

test('splices no untrusted pull request field into a run script', () => {
  const scripts = extractRunScripts(readWorkflow());

  assert.equal(scripts.length > 0, true, 'the workflow must run at least one script');
  const injected = scripts.filter((script) => UNTRUSTED_EXPRESSION.test(script));
  assert.deepEqual(
    injected,
    [],
    '`${{ github.event.* }}` and `${{ github.head_ref }}` are contributor-controlled on a public ' +
      'repository; expanded inside `run:` they become shell source. Pass them through env: instead',
  );
});

test('installs cleanly, then lints, builds and tests, in that order', () => {
  const scripts = extractRunScripts(readWorkflow());
  const expected = ['npm ci', 'npm run lint', 'npm run build', 'npm test'];
  const positions = expected.map((command) => scripts.indexOf(command));

  assert.deepEqual(
    expected.filter((_, index) => positions[index] === -1),
    [],
    'CI must run each of `npm ci`, `npm run lint`, `npm run build` and `npm test` as its own step: ' +
      'the lockfile install, the boundary lint, the build and the suite are the whole PR gate',
  );
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
    'the steps must run install, lint, build, test in that order, so each stage checks the ' +
      'artifact the previous one produced',
  );
});

test('the workflow carries none of the self-hosted runner preflight', () => {
  const workflow = readWorkflow();

  for (const [residue, pattern] of [
    ['the dedicated aic-runner identity', /aic-runner/],
    ['Lima mount inspection', /\bfindmnt\b/],
    ['the passwordless-sudo check', /\bsudo\b/],
    ['the Lima VM', /\blima\b/i],
    ['the ARM64 architecture requirement', /\b(?:ARM64|aarch64)\b/i],
  ]) {
    assert.doesNotMatch(
      workflow,
      pattern,
      `${residue} belongs to the retired self-hosted runner; on ${HOSTED_RUNNER} it either ` +
        'fails every run or checks nothing',
    );
  }
});

test('the repository no longer ships the private runner guide or VM definition', () => {
  assert.equal(
    existsSync(runnerGuidePath),
    false,
    'RUNNER.md documents a private runner the repository no longer uses; a public repository ' +
      'must not publish its private infrastructure operations',
  );
  assert.equal(
    existsSync(runnerDirectoryPath),
    false,
    '.github/runner/ holds the retired Lima VM definition; nothing runs it any more',
  );
});

test('the README neither links the runner guide nor lists a self-hosted runner', () => {
  const readme = readRequired(readmePath, 'README.md must remain available');

  assert.doesNotMatch(
    readme,
    /RUNNER\.md/,
    'README.md must not point at RUNNER.md, which no longer exists',
  );
  assert.doesNotMatch(
    readme,
    /Self-hosted runner/,
    'README.md must not advertise a self-hosted runner: CI runs on GitHub-hosted runners',
  );
});
