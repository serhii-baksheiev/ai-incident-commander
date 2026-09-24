import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The CI contract for a PUBLIC repository. Every pull request can come from an
// untrusted contributor, so ordinary PR validation runs on a disposable
// GitHub-hosted runner with a read-only token, no secrets, and no expression
// expanded anywhere but the top-level concurrency group. The workflow is read
// as text on purpose: no YAML dependency is installed, and the checks below
// are line-shaped enough not to need one.

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDirectoryPath = resolve(projectRoot, '.github/workflows');
const workflowPath = resolve(workflowsDirectoryPath, 'ci.yml');
const readmePath = resolve(projectRoot, 'README.md');
const runnerGuidePath = resolve(projectRoot, 'RUNNER.md');
const runnerDirectoryPath = resolve(projectRoot, '.github/runner');

const HOSTED_RUNNER = 'ubuntu-24.04';

// SELF_HOSTED and PRIVILEGED_TRIGGERS were the sweep's denylist. The sweep
// itself (publicSafetyViolations, below) no longer uses either: an allowlist
// on `on:` already refuses every trigger but pull_request/push, and an
// allowlist on `runs-on:` already refuses every runner but the hosted image,
// so a denylist entry can only ever repeat a rule the allowlist already
// states more strongly. Both constants stay in use as a second, independent
// check inside the ci.yml-specific tests below — a plain text search for
// "self-hosted" or a privileged event name anywhere in the file, not only
// where a value is structurally expected to be a trigger or a runner.
const SELF_HOSTED = /self-hosted/i;
const PRIVILEGED_TRIGGERS = ['pull_request_target', 'workflow_run', 'issue_comment'];
const WRITE_SCOPE = /:[ \t]*['"]?write\b/;
const WRITE_ALL = /write-all/;
const PINNED_ACTION = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const SECRET_REFERENCE = /\bsecrets\s*(?:\.|\[|:)/;
const TOKEN_REFERENCE = /\bgithub\.token\b/;

// Rule 1: `on:` may declare only these triggers, and a push must stay
// restricted to main.
const ALLOWED_TRIGGERS = new Set(['pull_request', 'push']);
const PUSH_BRANCHES_MAIN = /^\s{4}branches:\s*\[\s*main\s*\]\s*$/m;

// Rule 2: the top-level permissions block must be exactly `contents: read`,
// and no job may declare its own.
const PERMISSIONS_CONTENTS_READ = /^permissions:\s*\n\s{2}contents:\s*read\s*$/m;
const JOB_LEVEL_PERMISSIONS = /^[ \t]+permissions:/m;

// Rule 5: any expression at all, anywhere but the top-level concurrency
// block. Recognising only the "untrusted" contexts (github.event.*) was
// tried and lost to bracket access (github.event['pull_request']), a `}`
// inside a quoted format() argument, toJSON(github.event), github.ref_name,
// a `with:`/`env:` value, an indented continuation of a plain `run:` scalar,
// and a flow-mapping step (`- { run: "... ${{ ... }} ..." }`). The workflow
// has no legitimate need for one outside concurrency: a value a step needs
// travels through env:, where the shell or the action sees it as data, not
// source.
const EXPRESSION_IN_SCRIPT = /\$\{\{/;

// Rule 6: continue-on-error, anywhere.
const CONTINUE_ON_ERROR = /\bcontinue-on-error\s*:/;

// Rule 7 (ci.yml only): no step may carry `if:` or `shell:`. `if:` can make a
// gate step report success by skipping silently; `shell:` can swap the
// interpreter a script runs under.
const STEP_IF = /^\s*(?:-\s+)?if:\s*/;
const STEP_SHELL = /^\s*(?:-\s+)?shell:\s*/;

// The exact two values cancel-in-progress may hold. Rule 5 exempts the
// concurrency block from the no-expression rule entirely, which would let
// `cancel-in-progress: ${{ false }}` read as a live expression and pass; this
// allowlist closes that specific value back down to the two the workflow
// actually needs.
const CANCEL_IN_PROGRESS_ALLOWED = new Set(['true', "${{ github.ref != 'refs/heads/main' }}"]);

// What the retired self-hosted preflight checked, by the words it used to
// check it. Deliberately not a bare `sudo`: an ordinary `sudo apt-get` is
// legitimate on the hosted runner and has nothing to do with the retired
// machine.
const RETIRED_RUNNER_RESIDUE = [
  ['the dedicated aic-runner identity', /aic-runner/],
  ['Lima mount inspection', /\bfindmnt\b/],
  ['the host filesystem mount types', /\b(?:virtiofs|9p|fuse\.sshfs)\b/],
  ['the passwordless-sudo check', /\bsudo\s+-n\b|passwordless\s+sudo/i],
  ['the Lima VM', /\blima\b/i],
  ['the ARM64 architecture requirement', /\b(?:ARM64|aarch64)\b/i],
];

// Findings messages, spelled once and shared by publicSafetyViolations and
// every test that asserts on one of them, so a test can never assert a
// string that drifts from the one the sweep actually produces.
const ON_UNREADABLE_MESSAGE =
  'declares `on:` in a shape this sweep cannot read as a block mapping (a flow sequence, a bare ' +
  'scalar, or no `on:` block at all); an unreadable trigger set is refused, not allowed';
const PUSH_NOT_MAIN_MESSAGE = 'push trigger is not restricted to branches: [main]';
const PERMISSIONS_UNREADABLE_MESSAGE =
  'declares no readable top-level `permissions:` block (missing, empty, or not a block mapping); an ' +
  'unreadable or absent grant is refused, not defaulted';
const PERMISSIONS_NOT_CONTENTS_READ_MESSAGE = 'grants a permission other than exactly contents: read at the top level';
const PERMISSIONS_JOB_LEVEL_MESSAGE = 'declares job-level permissions, which can widen the top-level grant';
const JOBS_UNREADABLE_MESSAGE = 'declares no readable top-level `jobs:` block';
const CONTAINER_MESSAGE = 'runs a job in a container image, which a mutable tag can change under it';
const EXPRESSION_OUTSIDE_CONCURRENCY_MESSAGE = 'uses a ${{ }} expression outside the top-level concurrency: block';
const CONTINUE_ON_ERROR_MESSAGE = 'sets continue-on-error';

function onAllowlistMessage(disallowed) {
  return `triggers on ${disallowed.join(', ')}, outside the pull_request/push allowlist`;
}

function runsOnMessage(jobName) {
  return `job ${jobName} does not run on exactly runs-on: ${HOSTED_RUNNER}`;
}

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
// each with the lines of its own block. Returns null when `key:` is not a
// block-mapping header on its own line (a flow sequence, a flow mapping, a
// scalar value on the same line, or the key missing entirely) — every one of
// those shapes fails closed rather than being read as "no rule to check".
function topLevelBlock(workflow, key) {
  const lines = workflow.split('\n');
  const headerIndex = lines.findIndex((line) => new RegExp(`^${key}:\\s*(?:#.*)?$`).test(line));
  if (headerIndex === -1) return null;
  const body = blockBody(lines, headerIndex);
  const nonEmpty = body.filter((line) => line.trim() !== '' && !isComment(line));
  if (nonEmpty.length === 0) return null;
  const childIndent = Math.min(...nonEmpty.map(indentOf));
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

// Every `uses:` reference, comments excluded — scanned over the whole text
// rather than anchored to a line, so a block step (`- uses: x`), a flow-mapping
// step (`- { uses: x }`) and a value continued onto the next line are all read,
// and a quoted ref is unquoted the way YAML reads it.
function extractUses(workflow) {
  const text = workflow
    .split('\n')
    .filter((line) => !isComment(line))
    .join('\n');
  return [...text.matchAll(/\buses:\s*(['"]?[^\s,}#]+['"]?)/g)].map((match) => scalarValue(match[1]));
}

// A plain scalar as YAML would read it: a trailing ` # comment` dropped, then
// one pair of surrounding quotes. `false # note`, `'false'` and `"false"` are
// all the boolean false to the workflow parser, so they must be to the test.
function scalarValue(raw) {
  return raw
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim();
}

// Rule 1.
function onTriggerViolations(workflow) {
  const on = topLevelBlock(workflow, 'on');
  if (on === null) return [ON_UNREADABLE_MESSAGE];
  const findings = [];
  const disallowed = [...on.keys()].filter((key) => !ALLOWED_TRIGGERS.has(key));
  if (disallowed.length > 0) findings.push(onAllowlistMessage(disallowed));
  if (on.has('push') && !PUSH_BRANCHES_MAIN.test(on.get('push').join('\n'))) {
    findings.push(PUSH_NOT_MAIN_MESSAGE);
  }
  return findings;
}

// Rule 2.
function permissionsViolations(workflow) {
  const permissions = topLevelBlock(workflow, 'permissions');
  if (permissions === null) return [PERMISSIONS_UNREADABLE_MESSAGE];
  const findings = [];
  const keys = [...permissions.keys()];
  const isExactlyContentsRead = keys.length === 1 && keys[0] === 'contents' && PERMISSIONS_CONTENTS_READ.test(workflow);
  if (!isExactlyContentsRead) findings.push(PERMISSIONS_NOT_CONTENTS_READ_MESSAGE);
  if (JOB_LEVEL_PERMISSIONS.test(workflow)) findings.push(PERMISSIONS_JOB_LEVEL_MESSAGE);
  return findings;
}

// Rule 3.
function runsOnViolations(workflow) {
  const jobs = topLevelBlock(workflow, 'jobs');
  if (jobs === null || jobs.size === 0) return [JOBS_UNREADABLE_MESSAGE];
  const findings = [];
  for (const [name, body] of jobs) {
    const runsOnLines = body
      .filter((line) => /^\s*runs-on:/.test(line))
      .map((line) => scalarValue(line.replace(/^\s*runs-on:/, '')));
    if (runsOnLines.length !== 1 || runsOnLines[0] !== HOSTED_RUNNER) {
      findings.push(runsOnMessage(name));
    }
  }
  return findings;
}

// Rule 4.
function unpinnedActionViolations(workflow) {
  const unpinned = extractUses(workflow).filter((ref) => !PINNED_ACTION.test(ref));
  return unpinned.length > 0 ? [`uses an action not pinned to a 40-hex SHA: ${unpinned.join(', ')}`] : [];
}

// The workflow text with the top-level concurrency: block removed, so rule 5
// can be a single "no ${{ anywhere" scan without also refusing the one place
// an expression is legitimate.
function withoutConcurrencyBlock(workflow) {
  const lines = workflow.split('\n');
  const headerIndex = lines.findIndex((line) => /^concurrency:\s*(?:#.*)?$/.test(line));
  if (headerIndex === -1) return workflow;
  const body = blockBody(lines, headerIndex);
  return [...lines.slice(0, headerIndex), ...lines.slice(headerIndex + 1 + body.length)].join('\n');
}

// Rule 5.
function expressionViolations(workflow) {
  return EXPRESSION_IN_SCRIPT.test(withoutConcurrencyBlock(workflow)) ? [EXPRESSION_OUTSIDE_CONCURRENCY_MESSAGE] : [];
}

// Rule 7 (ci.yml only).
function stepGateBypassViolations(workflow) {
  return workflow
    .split('\n')
    .filter((line) => !isComment(line) && (STEP_IF.test(line) || STEP_SHELL.test(line)))
    .map((line) => line.trim());
}

// Every .yml/.yaml file in a workflows directory, sorted. A single source for
// the file list the sweep walks, so the sweep and its own self-test read the
// directory the same way.
function listWorkflowFiles(directoryPath) {
  return readdirSync(directoryPath)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();
}

// The full public-repository contract, applied to any workflow file's text.
// Returns one finding per rule broken; an empty list is a pass. This is the
// single allowlist that replaced the sweep's former denylist (self-hosted
// text, a list of privileged trigger names, a write-permission regex): every
// one of those was a specific shape of a rule this function now states
// positively — what may appear — so a shape nobody had yet thought to deny
// (an `issues` trigger, a runner group, a flow-mapping step) cannot pass by
// omission.
function publicSafetyViolations(workflow) {
  const findings = [];
  findings.push(...onTriggerViolations(workflow));
  findings.push(...permissionsViolations(workflow));
  findings.push(...runsOnViolations(workflow));
  findings.push(...unpinnedActionViolations(workflow));
  findings.push(...expressionViolations(workflow));
  if (SECRET_REFERENCE.test(workflow)) findings.push('references secrets');
  if (TOKEN_REFERENCE.test(workflow)) findings.push('references github.token');
  if (CONTINUE_ON_ERROR.test(workflow)) findings.push(CONTINUE_ON_ERROR_MESSAGE);
  if (/^\s*container:/m.test(workflow)) findings.push(CONTAINER_MESSAGE);
  return findings;
}

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
    '      - run: echo "${{ github.event[\'pull_request\'].title }}"',
    '      - run: echo "${{ format(\'{0}\', github.event.pull_request.title) }}"',
    '      - run: echo \'${{ toJSON(github.event) }}\'',
    '      - run: git checkout ${{ github.ref_name }}',
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
      'echo "${{ github.event[\'pull_request\'].title }}"',
      'echo "${{ format(\'{0}\', github.event.pull_request.title) }}"',
      'echo \'${{ toJSON(github.event) }}\'',
      'git checkout ${{ github.ref_name }}',
      'npm test',
    ],
    'the reader must return every run script whole, or an injected expression in a block ' +
      'scalar passes the guard unseen',
  );
  assert.deepEqual(
    scripts.map((script) => EXPRESSION_IN_SCRIPT.test(script)),
    [false, true, true, true, true, true, true, false],
    'the guard must flag every ${{ }} inside a run script, including bracket access, format(), ' +
      'toJSON() and github.ref_name, which a list of "untrusted" contexts let through',
  );
});

test('the cancel-in-progress reader sees a commented or quoted false as false', () => {
  assert.deepEqual(
    [
      ' false',
      ' false # superseded runs are kept',
      " 'false'",
      ' "false"',
      " ${{ github.ref != 'refs/heads/main' }}",
    ].map(scalarValue),
    ['false', 'false', 'false', 'false', "${{ github.ref != 'refs/heads/main' }}"],
    'a trailing comment or a pair of quotes must not hide a false from the concurrency check',
  );
});

test('the retired-preflight marker lines are recognised, and an ordinary sudo on the hosted runner is not', () => {
  // A hand-written sample of the retired self-hosted preflight's distinctive
  // lines, not the retired file itself: the file is gone from this checkout
  // (git history is not read at test time), so this fixture is what "every
  // line" below refers to.
  const retiredPreflightMarkers = [
    'if [[ "$runner_user" != aic-runner ]]; then',
    'mount_table=$(findmnt -rn -o FSTYPE,TARGET,SOURCE)',
    'virtiofs|9p|fuse.sshfs)',
    "if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then",
    "printf '::error::runner identity has passwordless sudo\\n'",
    "printf '::error::Lima host filesystem mount detected: %s\\n'",
    'runs-on: [self-hosted, Linux, ARM64, ai-incident-commander]',
  ];
  const unmatched = retiredPreflightMarkers.filter(
    (line) => !RETIRED_RUNNER_RESIDUE.some(([, pattern]) => pattern.test(line)),
  );
  assert.deepEqual(unmatched, [], 'every marker line in this retired-preflight fixture must still be recognised');

  const hostedSudo = 'sudo apt-get install -y --no-install-recommends jq';
  assert.deepEqual(
    RETIRED_RUNNER_RESIDUE.filter(([, pattern]) => pattern.test(hostedSudo)).map(([residue]) => residue),
    [],
    'a plain sudo is legitimate on the hosted runner; refusing it would blame the retired runner ' +
      'for a step that has nothing to do with it',
  );
});

test('the self-hosted marker matches regardless of case, so Self-Hosted or SELF-HOSTED cannot slip past the same way lowercase self-hosted would', () => {
  assert.match('runs-on: [Self-Hosted, Linux]', SELF_HOSTED);
  assert.match('runs-on: SELF-HOSTED', SELF_HOSTED);
  assert.doesNotMatch(`runs-on: ${HOSTED_RUNNER}`, SELF_HOSTED);
});

test('the trigger allowlist admits only pull_request and push, and fails closed when `on:` cannot be read as a block mapping', () => {
  const extraKey = ['on:', '  pull_request:', '  issues:'].join('\n');
  assert.deepEqual(
    onTriggerViolations(extraKey),
    [onAllowlistMessage(['issues'])],
    'a trigger outside {pull_request, push} must be named, even when `on:` itself is a readable block',
  );

  assert.deepEqual(
    onTriggerViolations(['on:', '  push:', "    branches: ['**']"].join('\n')),
    [PUSH_NOT_MAIN_MESSAGE],
    'a push trigger not restricted to main must be named',
  );

  const unreadableShapes = {
    'a flow sequence': 'on: [push, discussion_comment]',
    'a bare scalar': 'on: pull_request',
    'a header with a comment-only body': ['on:', '# nothing here', 'jobs:'].join('\n'),
  };
  for (const [shape, workflow] of Object.entries(unreadableShapes)) {
    assert.deepEqual(
      onTriggerViolations(workflow),
      [ON_UNREADABLE_MESSAGE],
      `an \`on:\` written as ${shape} must be refused as unreadable, not silently allowed because ` +
        'nothing matched the allowlist scan',
    );
  }
});

test('triggers only on pull_request and on pushes to main, never on a privileged event', () => {
  const workflow = readWorkflow();
  const triggers = topLevelBlock(workflow, 'on');

  assert.notEqual(triggers, null, 'the workflow must declare its triggers as a top-level `on:` block');
  assert.deepEqual(
    [...triggers.keys()].sort(),
    ['pull_request', 'push'],
    'ci.yml must run on BOTH pull_request and push: the allowlist below only refuses extra ' +
      'triggers, so this exact set is what keeps CI from being switched off',
  );
  assert.deepEqual(
    triggers.get('pull_request').filter((line) => line.trim() !== ''),
    [],
    'pull_request must carry no filter (paths, paths-ignore, types, branches): a filter can stop ' +
      'CI from running on a pull request at all',
  );
  assert.match(
    triggers.get('push').join('\n'),
    PUSH_BRANCHES_MAIN,
    'push must be restricted to branches: [main]',
  );
  assert.deepEqual(
    onTriggerViolations(workflow),
    [],
    'a public repository runs ordinary CI on pull_request and push only, and push only to main: any ' +
      'other trigger, or an unrestricted push, widens who can start a run and with what token',
  );
  assert.match(
    workflow,
    /^\s{2}pull_request:\s*$/m,
    'pull_request must run for every PR, so an untrusted contribution is validated before review',
  );
  for (const privileged of PRIVILEGED_TRIGGERS) {
    assert.doesNotMatch(
      workflow,
      new RegExp(`\\b${privileged}\\b`),
      `${privileged} runs with the base repository's token and secrets on attacker-influenced ` +
        'input; a public repository must not use it for ordinary CI',
    );
  }
});

test('the permissions allowlist requires exactly contents: read at the top level, and refuses a job-level grant', () => {
  const extraScopeAndJobLevel = [
    'permissions:',
    '  contents: read',
    '  actions: read',
    'jobs:',
    '  a:',
    '    permissions:',
    '      contents: write',
    '    steps:',
    '      - run: npm test',
  ].join('\n');

  assert.deepEqual(
    permissionsViolations(extraScopeAndJobLevel),
    [PERMISSIONS_NOT_CONTENTS_READ_MESSAGE, PERMISSIONS_JOB_LEVEL_MESSAGE],
    'a second top-level scope and a job-level permissions block must both be named, because either ' +
      'one alone can widen the token an untrusted PR runs with',
  );
});

test('the permissions allowlist fails closed when the top-level block is missing or unreadable', () => {
  const missing = ['jobs:', '  a:', '    runs-on: ubuntu-24.04', '    steps:', '      - run: npm test'].join('\n');
  const unreadable = ['permissions: {}', 'jobs:', '  a:', '    runs-on: ubuntu-24.04'].join('\n');

  for (const workflow of [missing, unreadable]) {
    assert.deepEqual(
      permissionsViolations(workflow),
      [PERMISSIONS_UNREADABLE_MESSAGE],
      'an absent permissions: block leaves the token at the repository default, and a flow mapping ' +
        '(`{}`) is not a block the sweep reads a scope out of; both must be refused, not read as ' +
        '"nothing to check"',
    );
  }
});

test('grants the token contents: read only, at the top level, with no job widening it', () => {
  const workflow = readWorkflow();

  assert.deepEqual(
    permissionsViolations(workflow),
    [],
    'the CI token must carry exactly one scope, contents: read, and no job may declare its own ' +
      'permissions block that could widen it',
  );
  assert.doesNotMatch(workflow, WRITE_ALL, 'write-all hands every scope to untrusted PR code');
  assert.doesNotMatch(
    workflow,
    WRITE_SCOPE,
    'no scope anywhere in the workflow may be write: untrusted PR code runs with this token',
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
  const cancelValues = workflow
    .split('\n')
    .filter((line) => !isComment(line))
    .map((line) => line.match(/^[ \t]{2}cancel-in-progress:(.*)$/)?.[1])
    .filter((value) => value !== undefined)
    .map(scalarValue);
  assert.equal(
    cancelValues.length,
    1,
    'concurrency must set cancel-in-progress exactly once: a second key silently overrides the first',
  );
  assert.notEqual(cancelValues[0], '', 'cancel-in-progress must have a value');
  assert.equal(
    CANCEL_IN_PROGRESS_ALLOWED.has(cancelValues[0]),
    true,
    'cancel-in-progress must be exactly `true` or the branch-aware expression that keeps main\'s ' +
      'runs uncancelled; rule 5 exempts the concurrency block from the no-expression rule entirely, ' +
      'so any other value — including a live `${{ false }}` — would otherwise read as a legitimate ' +
      'expression and silently disable cancellation for a burst of PR pushes',
  );
});

test('cancel-in-progress admits only `true` or the branch-aware expression, rejecting every other value', () => {
  assert.deepEqual(
    ['true', "${{ github.ref != 'refs/heads/main' }}", '${{ false }}', 'false', '${{ true }}'].map((value) =>
      CANCEL_IN_PROGRESS_ALLOWED.has(value),
    ),
    [true, true, false, false, false],
    '`${{ false }}` reads as a live expression under rule 5\'s concurrency exemption, and must still ' +
      'be refused here by value, not by shape',
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

test('every job must run on exactly ubuntu-24.04, refusing a custom label and a runner group alike', () => {
  const mixedRunners = [
    'jobs:',
    '  a:',
    '    runs-on: aic-box',
    '    steps:',
    '      - run: npm test',
    '  b:',
    '    runs-on:',
    '      group: private-pool',
    '    steps:',
    '      - run: npm test',
    '  c:',
    '    runs-on: ubuntu-24.04',
    '    steps:',
    '      - run: npm test',
  ].join('\n');

  assert.deepEqual(
    runsOnViolations(mixedRunners),
    [runsOnMessage('a'), runsOnMessage('b')],
    'a custom label (aic-box) and a runner group ({ group: private-pool }) must both be refused, and ' +
      'the compliant job (c) must not be, or the allowlist is not actually checking the runner',
  );
});

test('every job runs on the pinned GitHub-hosted ubuntu-24.04 image and nothing else', () => {
  const workflow = readWorkflow();

  assert.deepEqual(
    runsOnViolations(workflow),
    [],
    `every job must run on exactly \`runs-on: ${HOSTED_RUNNER}\`: a public repository's PRs must never ` +
      'reach a privately operated self-hosted machine, and a pinned image keeps CI reproducible',
  );
  assert.doesNotMatch(
    workflow,
    SELF_HOSTED,
    'no job may target a self-hosted runner: untrusted PR code would execute on private hardware',
  );
  assert.doesNotMatch(
    workflow,
    /\b(?:ubuntu|windows|macos)-latest\b/i,
    'a `-latest` image moves under the repository without a commit; pin the image version',
  );
});

test('pins every action to a full 40-character commit SHA', () => {
  const workflow = readWorkflow();
  const uses = extractUses(workflow);

  assert.equal(uses.length > 0, true, 'the workflow must use at least checkout and setup-node');
  const unpinned = uses.filter((ref) => !PINNED_ACTION.test(ref));
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
    SECRET_REFERENCE,
    'the workflow must not reference secrets: CI on a public repository runs untrusted PR code, ' +
      'and ordinary validation (install, lint, build, test) needs no credential',
  );
  assert.doesNotMatch(
    workflow,
    TOKEN_REFERENCE,
    'the workflow must not hand github.token to a step: it is the same credential as ' +
      'secrets.GITHUB_TOKEN under another name',
  );
});

test('no ${{ }} expression may appear outside the concurrency block, closing the with:, env:, continuation and flow-mapping channels', () => {
  const badExpressionsEverywhere = [
    'concurrency:',
    '  group: ${{ github.workflow }}-${{ github.ref }}',
    '  cancel-in-progress: true',
    'jobs:',
    '  a:',
    '    steps:',
    '      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
    '        with:',
    '          ref: ${{ github.event.pull_request.head.sha }}',
    '      - env:',
    '          NAME: ${{ github.actor }}',
    '        run: echo hi',
    '      - run: echo',
    '          ${{ github.event.pull_request.title }}',
    '      - { name: flow, run: "echo ${{ github.head_ref }}" }',
  ].join('\n');

  assert.deepEqual(
    expressionViolations(badExpressionsEverywhere),
    [EXPRESSION_OUTSIDE_CONCURRENCY_MESSAGE],
    'an expression in `with:`, `env:`, an indented continuation of a plain run: scalar, or a ' +
      'flow-mapping step must all be caught by one whole-file scan, or any one of those shapes is a ' +
      'channel the run-script-only reader never saw',
  );

  const onlyInConcurrency = [
    'concurrency:',
    '  group: ${{ github.workflow }}-${{ github.ref }}',
    "  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}",
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: npm test',
  ].join('\n');
  assert.deepEqual(
    expressionViolations(onlyInConcurrency),
    [],
    'the top-level concurrency: block is the one place an expression is legitimate, and must not be ' +
      'flagged, or the real ci.yml (which keys concurrency on github.workflow and github.ref) would ' +
      'never pass',
  );
});

test('the expression-anywhere rule catches secrets and the token even through toJSON() and bracket access, which the text-only patterns alone miss', () => {
  const throughFunctionsAndBrackets = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - env:',
    '          ALL: ${{ toJSON(secrets) }}',
    "          T: ${{ github['token'] }}",
    '        run: npm test',
  ].join('\n');

  assert.equal(
    SECRET_REFERENCE.test(throughFunctionsAndBrackets),
    false,
    'toJSON(secrets) has no `.`, `[` or `:` right after "secrets", so the plain-text secrets pattern ' +
      'alone does not see it — the expression rule is what has to catch this one',
  );
  assert.equal(
    TOKEN_REFERENCE.test(throughFunctionsAndBrackets),
    false,
    "github['token'] is not the literal text \"github.token\", so the plain-text token pattern alone " +
      'does not see it either',
  );
  assert.deepEqual(expressionViolations(throughFunctionsAndBrackets), [EXPRESSION_OUTSIDE_CONCURRENCY_MESSAGE]);
});

test('expands no ${{ }} expression anywhere in the workflow outside the concurrency block', () => {
  const workflow = readWorkflow();

  assert.deepEqual(
    expressionViolations(workflow),
    [],
    'an expression is substituted before a shell, an action input, or `env:` ever sees it, and on a ' +
      'public repository much of the context (event payload, ref names) is contributor-controlled. ' +
      'The only place an expression belongs is the top-level concurrency group, which GitHub resolves ' +
      'before any step runs; pass any value a step needs through env: instead',
  );
  assert.equal(extractRunScripts(workflow).length > 0, true, 'the workflow must run at least one script');
});

test('no step or job may continue on error, so a red lint, build or test cannot report green', () => {
  const continuing = readWorkflow()
    .split('\n')
    .filter((line) => !isComment(line) && CONTINUE_ON_ERROR.test(line))
    .map((line) => line.trim());

  assert.deepEqual(
    continuing,
    [],
    'continue-on-error turns a failing step or job into a passing check; the PR gate is only a ' +
      'gate if every stage of it can fail the run. Its default, false, needs no key',
  );
});

test('continue-on-error is refused by the sweep in any workflow file, not only ci.yml', () => {
  const secondFile = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: npm test',
    '        continue-on-error: true',
  ].join('\n');

  assert.equal(
    publicSafetyViolations(secondFile).includes(CONTINUE_ON_ERROR_MESSAGE),
    true,
    'continue-on-error must be caught by the sweep itself, because a second workflow file carrying ' +
      "it is invisible to a check that only reads ci.yml's own text",
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

  for (const [residue, pattern] of RETIRED_RUNNER_RESIDUE) {
    assert.doesNotMatch(
      workflow,
      pattern,
      `${residue} belongs to the retired self-hosted runner; on ${HOSTED_RUNNER} it either ` +
        'fails every run or checks nothing',
    );
  }
});

test('no step in ci.yml sets if: or shell:, so a gate step cannot skip itself or swap its interpreter', () => {
  assert.deepEqual(
    stepGateBypassViolations(readWorkflow()),
    [],
    'the gate steps (install, lint, build, test) must run unconditionally, in the default shell, or ' +
      'one of them can report green without actually running',
  );
});

test('the if:/shell: guard fires on a step carrying either key, the two forms a public PR could add without turning ci.yml red', () => {
  const mutated = [
    'jobs:',
    '  checks:',
    '    steps:',
    '      - name: Full test suite',
    '        run: npm test',
    '        if: ${{ false }}',
    '      - name: Clean dependency install',
    '        shell: true {0}',
    '        run: npm ci',
  ].join('\n');

  assert.deepEqual(stepGateBypassViolations(mutated), ['if: ${{ false }}', 'shell: true {0}']);
});

test('an issue-triage workflow using github-script on attacker-controlled issue text is refused by the trigger allowlist and the expression rule together', () => {
  const triage = [
    'on:',
    '  issues:',
    '    types: [opened]',
    'jobs:',
    '  triage:',
    '    runs-on: ubuntu-24.04',
    '    steps:',
    '      - uses: actions/github-script@11d5960a326750d5838078e36cf38b85af677262',
    '        with:',
    '          script: |',
    '            console.log("${{ github.event.issue.title }}")',
  ].join('\n');

  assert.deepEqual(publicSafetyViolations(triage), [
    onAllowlistMessage(['issues']),
    PERMISSIONS_UNREADABLE_MESSAGE,
    EXPRESSION_OUTSIDE_CONCURRENCY_MESSAGE,
  ]);
});

test('a workflow with a flow-sequence trigger, no permissions block, two mislabelled runners, and continue-on-error is refused on every count', () => {
  const misc = [
    'on: [push, discussion_comment]',
    'jobs:',
    '  a:',
    '    runs-on: aic-box',
    '    continue-on-error: true',
    '    env:',
    '      ALL: ${{ toJSON(secrets) }}',
    "      T: ${{ github['token'] }}",
    '    steps:',
    '      - run: npm test',
    '        if: ${{ false }}',
    '  b:',
    '    runs-on:',
    '      group: private-pool',
    '    steps:',
    '      - run: npm test',
  ].join('\n');

  assert.deepEqual(publicSafetyViolations(misc), [
    ON_UNREADABLE_MESSAGE,
    PERMISSIONS_UNREADABLE_MESSAGE,
    runsOnMessage('a'),
    runsOnMessage('b'),
    EXPRESSION_OUTSIDE_CONCURRENCY_MESSAGE,
    CONTINUE_ON_ERROR_MESSAGE,
  ]);
});

test('a workflow with a bare pull_request trigger, an unreadable permissions map, a continuation and a flow-mapping expression is refused on every count', () => {
  const plain = [
    'on: pull_request',
    'permissions: {}',
    'jobs:',
    '  a:',
    '    runs-on: ubuntu-24.04',
    '    steps:',
    '      - run: echo',
    '          ${{ github.event.pull_request.title }}',
    '      - { name: flow, run: "echo ${{ github.head_ref }}" }',
  ].join('\n');

  assert.deepEqual(publicSafetyViolations(plain), [
    ON_UNREADABLE_MESSAGE,
    PERMISSIONS_UNREADABLE_MESSAGE,
    EXPRESSION_OUTSIDE_CONCURRENCY_MESSAGE,
  ]);
});

test('the every-workflow sweep names each allowlist rule a workflow breaks, so it is not vacuous', () => {
  const unsafe = [
    'on:',
    '  issues:',
    'permissions:',
    '  contents: write',
    'jobs:',
    '  x:',
    '    runs-on: aic-box',
    '    continue-on-error: true',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - run: echo ${{ github.ref_name }}',
    '      - env:',
    '          A: ${{ secrets.NPM_TOKEN }}',
    '          B: ${{ github.token }}',
    '        run: npm test',
  ].join('\n');

  assert.deepEqual(publicSafetyViolations(unsafe), [
    onAllowlistMessage(['issues']),
    PERMISSIONS_NOT_CONTENTS_READ_MESSAGE,
    runsOnMessage('x'),
    'uses an action not pinned to a 40-hex SHA: actions/checkout@v4',
    EXPRESSION_OUTSIDE_CONCURRENCY_MESSAGE,
    'references secrets',
    'references github.token',
    CONTINUE_ON_ERROR_MESSAGE,
  ]);

  const compliantHead = ['on:', '  pull_request:', 'permissions:', '  contents: read', 'jobs:', '  x:'];
  const pinningShapes = {
    'a flow-mapping step': ['      - { uses: evil/action@main, with: { a: b } }'],
    'a value continued onto the next line': ['      - uses:', '          evil/action@main'],
  };
  for (const [shape, steps] of Object.entries(pinningShapes)) {
    const workflow = [...compliantHead, `    runs-on: ${HOSTED_RUNNER}`, '    steps:', ...steps].join('\n');
    assert.deepEqual(
      publicSafetyViolations(workflow),
      ['uses an action not pinned to a 40-hex SHA: evil/action@main'],
      `an unpinned action written as ${shape} must be named like a block-form one`,
    );
  }

  const quotedPinned = [
    ...compliantHead,
    `    runs-on: ${HOSTED_RUNNER} # hosted`,
    '    steps:',
    `      - uses: "actions/checkout@${'a'.repeat(40)}"`,
  ].join('\n');
  assert.deepEqual(
    publicSafetyViolations(quotedPinned),
    [],
    'a quoted pinned ref and a commented runner are what YAML reads as compliant, so neither is a finding',
  );

  const containerized = [...compliantHead, `    runs-on: ${HOSTED_RUNNER}`, '    container: attacker/image:latest'].join('\n');
  assert.deepEqual(publicSafetyViolations(containerized), [CONTAINER_MESSAGE]);

  assert.ok(
    publicSafetyViolations(['on:', '  pull_request:', 'permissions:', '  contents: read'].join('\n')).includes(
      JOBS_UNREADABLE_MESSAGE,
    ),
    'a workflow with no readable jobs: block must be refused, not pass with nothing to check',
  );
});

test('the workflow-file lister reads every .yml and .yaml file in a directory, not only ci.yml', () => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'ci-workflow-sweep-'));
  try {
    writeFileSync(join(fixtureDirectory, 'ci.yml'), 'on: {}\n');
    writeFileSync(join(fixtureDirectory, 'triage.yaml'), 'on: {}\n');
    writeFileSync(join(fixtureDirectory, 'README.md'), '# not a workflow\n');
    assert.deepEqual(
      listWorkflowFiles(fixtureDirectory),
      ['ci.yml', 'triage.yaml'],
      'the lister must return every .yml and .yaml file in the directory — narrowing it to ci.yml ' +
        'alone is exactly how a second, unreviewed workflow file becomes invisible to the sweep',
    );
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('every workflow file, not only ci.yml, keeps the public-repository security rules', () => {
  const workflowFiles = listWorkflowFiles(workflowsDirectoryPath);

  assert.equal(
    workflowFiles.includes('ci.yml'),
    true,
    'the sweep must at least see ci.yml, or it is reading the wrong directory',
  );
  const findings = workflowFiles.flatMap((name) =>
    publicSafetyViolations(readFileSync(resolve(workflowsDirectoryPath, name), 'utf8')).map(
      (finding) => `${name}: ${finding}`,
    ),
  );
  assert.deepEqual(
    findings,
    [],
    'GitHub runs every file in .github/workflows/ on this public repository, so a second workflow ' +
      'can reopen what ci.yml closes: an event outside the pull_request/push allowlist, a permission ' +
      'wider than contents: read, a runner other than the pinned hosted image, an unpinned action, an ' +
      'expression outside the concurrency block, or continue-on-error',
  );
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

/**
 * AIC-57 asks for a bounded CI regression of the T-4 race matrix, and the
 * durable-run substrate's live rows (claims, fences, replay, retention) were
 * until now proved only on a developer's machine. The live PostgreSQL lane runs
 * in CI after the suite, against a PostgreSQL service container that mirrors
 * `infra/postgres/compose.yaml` — same image line, trust auth on loopback, no
 * password, so the job still needs no secret (see the rule above).
 */
test('runs the live PostgreSQL lane after the suite, against a service pinned by digest and bound to loopback', () => {
  const workflow = readWorkflow();
  const scripts = extractRunScripts(workflow);
  const suite = scripts.indexOf('npm test');
  const live = scripts.indexOf('npm run test:live-postgres');
  assert.ok(suite >= 0 && live > suite, 'CI must run `npm run test:live-postgres` as its own step after `npm test`');

  const composeImage = readFileSync(resolve(projectRoot, 'infra/postgres/compose.yaml'), 'utf8').match(/image:\s*(\S+)/)[1];
  const serviceImage = workflow.match(/services:\s*\n\s+postgres:\s*\n\s+image:\s*(\S+)/)?.[1];
  assert.ok(serviceImage, 'the job must declare a `postgres` service container');
  assert.match(serviceImage, /@sha256:[0-9a-f]{64}$/, 'the service image must be pinned by digest, like every action is pinned by SHA');
  assert.equal(serviceImage.split('@')[0], composeImage, 'the CI service must run the image the local compose lane runs');

  assert.match(workflow, /POSTGRES_HOST_AUTH_METHOD:\s*trust/, 'the service trusts local connections, as the compose lane does');
  assert.doesNotMatch(workflow, /POSTGRES_PASSWORD/, 'no password: the job carries no credential at all');
  assert.match(workflow, /-\s*['"]?127\.0\.0\.1:5432:5432['"]?/, 'the service port is published on loopback only');
  assert.match(
    workflow,
    /AIC_POSTGRES_URL:\s*postgresql:\/\/aic@127\.0\.0\.1:5432\/aic\b/,
    'the live step reaches the service through a passwordless loopback URL',
  );
});
