import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(projectRoot, '.github/workflows/ci.yml');
const limaConfigPath = resolve(projectRoot, '.github/runner/lima.yaml');
const runnerGuidePath = resolve(projectRoot, 'RUNNER.md');
const readmePath = resolve(projectRoot, 'README.md');

function readRequired(path, message) {
  assert.equal(existsSync(path), true, message);
  return readFileSync(path, 'utf8');
}

function extractRunnerPreflight(workflow) {
  const lines = workflow.split('\n');
  const stepIndex = lines.findIndex((line) => /- name:\s*Runner requirement preflight\s*$/.test(line));
  assert.notEqual(stepIndex, -1, 'workflow must define the runner requirement preflight step');

  const runIndex = lines.findIndex(
    (line, index) => index > stepIndex && /^\s+run:\s*\|\s*$/.test(line),
  );
  assert.notEqual(runIndex, -1, 'runner requirement preflight must use a literal run block');

  const runIndent = lines[runIndex].match(/^\s*/)[0].length;
  const scriptLines = [];
  for (const line of lines.slice(runIndex + 1)) {
    if (line.trim() !== '' && line.match(/^\s*/)[0].length <= runIndent) break;
    scriptLines.push(line.trim() === '' ? '' : line.slice(runIndent + 2));
  }
  return scriptLines.join('\n');
}

function writeCommand(binPath, name, body) {
  const commandPath = join(binPath, name);
  writeFileSync(commandPath, `#!/bin/sh\n${body}\n`);
  chmodSync(commandPath, 0o755);
}

function runRunnerPreflight({
  findmnt = { output: 'ext4 / /dev/vda1', status: 0 },
  identity = 'aic-runner',
  passwordlessSudo = false,
} = {}) {
  const workflow = readRequired(
    workflowPath,
    '.github/workflows/ci.yml must define the repository CI contract',
  );
  const script = extractRunnerPreflight(workflow);
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'aic-runner-preflight-'));
  const binPath = join(fixtureRoot, 'bin');
  mkdirSync(binPath);

  try {
    for (const tool of ['bash', 'git', 'node']) writeCommand(binPath, tool, 'exit 0');
    writeCommand(
      binPath,
      'uname',
      'case "$1" in\n  -s) printf \'Linux\\n\' ;;\n  -m) printf \'aarch64\\n\' ;;\n  *) exit 2 ;;\nesac',
    );
    writeCommand(binPath, 'id', `printf '%s\\n' '${identity}'`);
    writeCommand(binPath, 'sudo', `exit ${passwordlessSudo ? 0 : 1}`);
    if (findmnt !== null) {
      writeCommand(
        binPath,
        'findmnt',
        `case " $* " in\n  *" -t "*) exit 65 ;;\nesac\ncase " $* " in\n  *" -o FSTYPE,TARGET,SOURCE "*) ;;\n  *) exit 64 ;;\nesac\n${findmnt.output ? `printf '%s\\n' '${findmnt.output}'\n` : ''}exit ${findmnt.status}`,
      );
    }

    return spawnSync('/bin/bash', ['-c', script], {
      encoding: 'utf8',
      // The probe supplies its own PATH: the preflight must see only the fake
      // tools written above, never the ones installed on this machine.
      env: childEnv({ PATH: binPath }),
    });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function preflightDiagnostics(result) {
  return `status=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`;
}

test('runs pull requests and main pushes only on the repository Linux ARM64 runner', () => {
  const workflow = readRequired(
    workflowPath,
    '.github/workflows/ci.yml must define the repository CI contract',
  );

  assert.match(workflow, /^on:\s*$/m);
  assert.match(workflow, /^\s{2}pull_request:\s*$/m);
  assert.match(workflow, /^\s{2}push:\s*$/m);
  assert.match(workflow, /^\s{4}branches:\s*\[\s*main\s*\]\s*$/m);
  assert.match(
    workflow,
    /^\s+runs-on:\s*\[\s*self-hosted\s*,\s*Linux\s*,\s*ARM64\s*,\s*ai-incident-commander\s*\]\s*$/m,
  );
  assert.doesNotMatch(workflow, /^\s+runs-on:.*\bmacOS\b.*$/im);
  assert.doesNotMatch(workflow, /\b(?:ubuntu|windows|macos)-latest\b/i);

  assert.match(workflow, /^permissions:\s*\n\s{2}contents:\s*read\s*$/m);
  assert.doesNotMatch(workflow, /(?:write-all|contents:\s*write)/);
  assert.match(workflow, /^concurrency:\s*$/m);
  assert.match(workflow, /^\s{2}group:\s*.*github\.workflow.*github\.ref.*$/m);
  assert.match(workflow, /^\s{2}cancel-in-progress:\s*(?!false\s*$).+$/m);

  const timeouts = [...workflow.matchAll(/^\s+timeout-minutes:\s*(\d+)\s*$/gm)].map((match) =>
    Number(match[1]),
  );
  assert.equal(timeouts.length > 0, true, 'each CI run needs an explicit timeout');
  assert.equal(
    timeouts.every((timeout) => timeout > 0 && timeout <= 30),
    true,
    'CI timeouts must be positive and no longer than 30 minutes',
  );

  assert.match(workflow, /^\s+- uses:\s*actions\/checkout@[0-9a-f]{40}\s*$/im);
  assert.match(
    workflow,
    /actions\/checkout@[0-9a-f]{40}[\s\S]*?persist-credentials:\s*false[\s\S]*?actions\/setup-node@[0-9a-f]{40}/i,
  );

  assert.match(workflow, /^\s+- name:\s*.*runner.*(?:need|require|preflight).*$/im);
  assert.match(workflow, /command -v/);
  assert.match(workflow, /::error::/);
  assert.match(workflow, /uname\s+-s/);
  assert.match(workflow, /uname\s+-m/);
  assert.match(workflow, /\bLinux\b/);
  assert.match(workflow, /\b(?:aarch64|arm64)\b/i);
  for (const tool of ['bash', 'git', 'node']) {
    assert.match(workflow, new RegExp(`\\b${tool}\\b`), `runner preflight must check ${tool}`);
  }
  assert.match(workflow, /^\s+run:\s*node --test\s*$/m);
});

test('fails the runner preflight when a Lima host filesystem mount is present', () => {
  for (const mountType of ['virtiofs', '9p', 'fuse.sshfs']) {
    const result = runRunnerPreflight({
      findmnt: { output: `${mountType} /mnt/lima-home host-home`, status: 0 },
    });

    assert.notEqual(
      result.status,
      0,
      `runner preflight must reject a ${mountType} host filesystem mount\n${preflightDiagnostics(result)}`,
    );
    assert.match(
      result.stdout,
      /::error::Lima host filesystem mount detected:/,
      `runner preflight must reject ${mountType} because it detected a host mount\n${preflightDiagnostics(result)}`,
    );
    assert.doesNotMatch(
      result.stdout,
      /::error::failed to inspect Lima host filesystem mounts/,
      `a valid full mount table must not be reported as an inspection failure\n${preflightDiagnostics(result)}`,
    );
  }
});

test('fails the runner preflight when findmnt is missing', () => {
  const result = runRunnerPreflight({ findmnt: null });

  assert.notEqual(
    result.status,
    0,
    `runner preflight must treat findmnt as a required tool\n${preflightDiagnostics(result)}`,
  );
});

test('fails the runner preflight when findmnt cannot inspect mounts', () => {
  const result = runRunnerPreflight({ findmnt: { output: '', status: 42 } });

  assert.notEqual(
    result.status,
    0,
    `runner preflight must fail closed when findmnt exits nonzero\n${preflightDiagnostics(result)}`,
  );
  assert.match(result.stdout, /::error::failed to inspect Lima host filesystem mounts/);
});

test('accepts the runner preflight when findmnt reports no host mounts', () => {
  const result = runRunnerPreflight();

  assert.equal(
    result.status,
    0,
    `runner preflight must accept a clean mount inspection\n${preflightDiagnostics(result)}`,
  );
});

test('fails the runner preflight outside the dedicated runner identity', () => {
  const result = runRunnerPreflight({ identity: 'eru' });

  assert.notEqual(
    result.status,
    0,
    `runner preflight must require the aic-runner identity\n${preflightDiagnostics(result)}`,
  );
});

test('fails the runner preflight when the runner has passwordless sudo', () => {
  const result = runRunnerPreflight({ passwordlessSudo: true });

  assert.notEqual(
    result.status,
    0,
    `runner preflight must reject passwordless sudo\n${preflightDiagnostics(result)}`,
  );
});

test('tracks a Lima VM definition with every host credential-sharing path disabled', () => {
  const limaConfig = readRequired(
    limaConfigPath,
    '.github/runner/lima.yaml must be the tracked runner VM definition',
  );

  assert.match(limaConfig, /^vmType:\s*["']?vz["']?\s*$/m);
  assert.match(limaConfig, /^arch:\s*["']?aarch64["']?\s*$/m);
  assert.match(limaConfig, /^plain:\s*true\s*$/m);
  assert.match(limaConfig, /^mounts:\s*\[\s*\]\s*$/m);
  assert.match(limaConfig, /^propagateProxyEnv:\s*false\s*$/m);

  const sshBlock = limaConfig.match(/^ssh:\s*\n((?:[ \t]+.*(?:\n|$))*)/m)?.[1];
  assert.notEqual(sshBlock, undefined, 'Lima config must define guest SSH isolation');
  assert.match(sshBlock, /^\s+loadDotSSHPubKeys:\s*false\s*$/m);
  assert.match(sshBlock, /^\s+forwardAgent:\s*false\s*$/m);
});

test('provisions the repository runner inside a dedicated Lima VM without host mounts', () => {
  const guide = readRequired(runnerGuidePath, 'RUNNER.md must document runner operations');
  const readme = readRequired(readmePath, 'README.md must remain available');

  const installationBlock = guide.match(/## Installation[\s\S]*?```bash\n([\s\S]*?)\n```/)?.[1];
  assert.notEqual(installationBlock, undefined, 'RUNNER.md must include a bash installation block');
  const failFast = installationBlock.search(/^\s*set\s+(?:-[a-z]*e[a-z]*|-o\s+errexit)\b/im);
  const checksum = installationBlock.indexOf('shasum -a 256 -c -');
  const extraction = installationBlock.indexOf('tar xzf');
  assert.equal(
    failFast >= 0 && failFast < checksum && failFast < extraction,
    true,
    'runner installation must enable fail-fast before checksum verification and extraction',
  );

  assert.match(guide, /\bLima\b/);
  assert.match(guide, /^arch:\s*["']?aarch64["']?\s*$/m);
  assert.match(guide, /^mounts:\s*\[\s*\]\s*$/m);
  assert.match(guide, /limactl\s+start[^\n]*--name(?:=|\s+)ai-incident-commander-runner/);
  assert.match(guide, /limactl\s+shell\s+ai-incident-commander-runner/);
  assert.match(guide, /actions-runner-linux-arm64-/);
  assert.match(guide, /https:\/\/github\.com\/serhii-baksheiev\/ai-incident-commander/);
  assert.match(guide, /--name\s+linux-arm64-01/);
  assert.match(guide, /--labels\s+self-hosted,Linux,ARM64,ai-incident-commander/);
  assert.doesNotMatch(guide, /actions-runner-osx-arm64-/);
  assert.doesNotMatch(guide, /LaunchAgent/i);
  assert.match(readme, /\[Self-hosted runner\]\(RUNNER\.md\)/);
});

test('provisions and installs the runner service as the dedicated runner identity', () => {
  const guide = readRequired(runnerGuidePath, 'RUNNER.md must document runner operations');
  const installationBlock = guide.match(/## Installation[\s\S]*?```bash\n([\s\S]*?)\n```/)?.[1];
  assert.notEqual(installationBlock, undefined, 'RUNNER.md must include a bash installation block');

  assert.match(
    installationBlock,
    /\b(?:adduser|useradd)\b[^\n]*\baic-runner\b/,
    'installation must provision the dedicated aic-runner guest identity',
  );
  assert.match(
    installationBlock,
    /\.\/svc\.sh\s+install\s+["']?aic-runner["']?\b/,
    'runner service must be installed as aic-runner',
  );
  assert.doesNotMatch(
    installationBlock,
    /\.\/svc\.sh\s+install\s+["']?\$\(id\s+-un\)/,
    'runner service identity must not depend on the guest operator account',
  );
  assert.doesNotMatch(installationBlock, /\beru\b/);
});

test('scopes private runner operations without relying on sudo chdir', () => {
  const guide = readRequired(runnerGuidePath, 'RUNNER.md must document runner operations');
  const lines = guide.split('\n');
  const privateRunnerCd =
    /\bcd\s+(?:["']?\$runner_dir["']?|["']?\/home\/aic-runner\/actions-runner-ai-incident-commander["']?)/;
  const scopedRunnerCd =
    /\bcd\s+(?:["']?\$runner_dir["']?|["']?\$[1-9]["']?|["']?\/home\/aic-runner\/actions-runner-ai-incident-commander["']?)/;
  const privateRunnerPath = /\/home\/aic-runner\/actions-runner-ai-incident-commander/;
  const identityInlineShell =
    /(?:sudo\s+-H\s+-u\s+aic-runner|runuser\s+-u\s+aic-runner\s+--)\s+bash\s+-(?:c|lc)\b/;
  const identityHeredocShell =
    /(?:sudo\s+-H\s+-u\s+aic-runner|runuser\s+-u\s+aic-runner\s+--)\s+bash\s+-s\b/;
  const rootInlineShell = /\bsudo\s+bash\s+-(?:c|lc)\b/;
  const rootHeredocShell = /\bsudo\s+bash\s+-s\b/;
  const userOwnedOperation =
    /(?:\bcurl\s+-fsSLO\b|\bshasum\s+-a\s+256\b|\btar\s+xzf\b|\brm\s+["']?\$runner_asset|\.\/config\.sh\b)/;

  function hasInlineScopedDirectory(line, shell, operation) {
    const cdIndex = line.search(scopedRunnerCd);
    const operationIndex = line.search(operation);
    return (
      cdIndex >= 0 &&
      operationIndex > cdIndex &&
      shell.test(line.slice(0, cdIndex)) &&
      /(?:&&|;)/.test(line.slice(cdIndex, operationIndex)) &&
      (privateRunnerCd.test(line) || privateRunnerPath.test(line))
    );
  }

  const violations = [];
  let heredocScope = null;
  let heredocDelimiter = null;
  let heredocHasRunnerCd = false;
  for (const line of lines) {
    if (heredocDelimiter !== null && line.trim() === heredocDelimiter) {
      heredocScope = null;
      heredocDelimiter = null;
      heredocHasRunnerCd = false;
      continue;
    }

    const heredoc = line.match(/<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/);
    if (heredoc && identityHeredocShell.test(line.slice(0, heredoc.index))) {
      heredocScope = 'identity';
      heredocDelimiter = heredoc[1];
      heredocHasRunnerCd = false;
    } else if (heredoc && rootHeredocShell.test(line.slice(0, heredoc.index))) {
      heredocScope = 'root';
      heredocDelimiter = heredoc[1];
      heredocHasRunnerCd = false;
    }
    if (heredocScope !== null && scopedRunnerCd.test(line)) heredocHasRunnerCd = true;

    if (/\bsudo\b[^\n]*(?:--chdir(?:=|\s)|\s-D(?:=|\s))/.test(line)) {
      violations.push(`sudo chdir is not portable: ${line}`);
    }
    if (
      userOwnedOperation.test(line) &&
      !(heredocScope === 'identity' && heredocHasRunnerCd) &&
      !hasInlineScopedDirectory(line, identityInlineShell, userOwnedOperation)
    ) {
      violations.push(`user-owned operation is not identity-scoped: ${line}`);
    }
    if (/\.\/svc\.sh\b/.test(line)) {
      const svcIndex = line.search(/\.\/svc\.sh\b/);
      if (
        heredocScope === 'identity' ||
        /(?:\bsudo\b[^\n]*\s-u\s+aic-runner\b|\brunuser\s+-u\s+aic-runner\b)/.test(
          line.slice(0, svcIndex),
        )
      ) {
        violations.push(`root-required svc operation claims aic-runner: ${line}`);
      }
      if (
        !(heredocScope === 'root' && heredocHasRunnerCd) &&
        !hasInlineScopedDirectory(line, rootInlineShell, /\.\/svc\.sh\b/)
      ) {
        violations.push(`svc operation is not scoped by a root shell: ${line}`);
      }
    }
    if (
      privateRunnerCd.test(line) &&
      heredocScope === null &&
      !identityInlineShell.test(line.slice(0, line.search(privateRunnerCd))) &&
      !rootInlineShell.test(line.slice(0, line.search(privateRunnerCd)))
    ) {
      violations.push(`private runner directory uses an ordinary operator cd: ${line}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `runner directory operations must use portable identity or root shells:\n${violations.join('\n')}`,
  );
});

test('documents VM-scoped runner verification and lifecycle operations', () => {
  const guide = readRequired(runnerGuidePath, 'RUNNER.md must document runner operations');

  assert.match(guide, /limactl\s+list/);
  assert.match(guide, /mounts:\s*\[\s*\]/);
  assert.match(guide, /host[^\n]*(?:home|credential)|(?:home|credential)[^\n]*host/i);
  assert.match(guide, /\.\/svc\.sh install/);
  assert.match(guide, /\.\/svc\.sh start/);
  assert.match(guide, /\.\/svc\.sh status/);
  assert.match(guide, /\.\/svc\.sh stop/);
  assert.match(guide, /\.\/config\.sh remove/);
  assert.match(
    guide,
    /gh api \/repos\/serhii-baksheiev\/ai-incident-commander\/actions\/runners/,
  );
  assert.match(guide, /online/);
  assert.match(guide, /self-hosted,Linux,ARM64,ai-incident-commander/);
});
