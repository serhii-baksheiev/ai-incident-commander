import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(projectRoot, '.github/workflows/ci.yml');
const limaConfigPath = resolve(projectRoot, '.github/runner/lima.yaml');
const runnerGuidePath = resolve(projectRoot, 'RUNNER.md');
const readmePath = resolve(projectRoot, 'README.md');

function readRequired(path, message) {
  assert.equal(existsSync(path), true, message);
  return readFileSync(path, 'utf8');
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
  const workflow = readRequired(
    workflowPath,
    '.github/workflows/ci.yml must define the repository CI contract',
  );

  assert.match(
    workflow,
    /^(?=[\s\S]*\bfindmnt\b)(?=[\s\S]*\bvirtiofs\b)(?=[\s\S]*\b9p\b)(?=[\s\S]*\bfuse\.sshfs\b)(?=[\s\S]*\bfindmnt\b[^\n]*[\s\S]*?\bthen\b[\s\S]*?::error::[\s\S]*?(?:\bexit\s+1\b|\b(?:failed|missing|status)\s*=\s*1\b))[\s\S]*$/i,
    'runner preflight must detect supported Lima host mount types and fail the job',
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
