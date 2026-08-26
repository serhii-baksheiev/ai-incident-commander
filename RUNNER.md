# Self-hosted GitHub Actions runner

`.github/workflows/ci.yml` runs pull requests and pushes to `main` on a
repository-specific macOS ARM64 runner. This keeps CI independent of
GitHub-hosted minutes and prevents a runner registered to another repository
from satisfying this workflow's label set.

## Security boundary

The workflow executes pull-request code on a persistent maintainer-controlled
host. This is acceptable only while the repository remains private, is not a
fork, and untrusted users cannot open runnable pull requests. Reassess the
trigger before making the repository public, enabling forks, or granting write
access to untrusted accounts. `contents: read` and
`persist-credentials: false` reduce the job token's reach; they do not isolate
the host from code the job executes.

## Installation

Runner registrations are per repository. Use the dedicated directory
`~/actions-runner-ai-incident-commander`; do not reuse another repository's
runner directory or service.

The commands below download the current Apple Silicon runner, verify the SHA-256
digest published with the GitHub release, register the repository-specific
label, and install the runner as a user LaunchAgent.

```bash
set -euo pipefail

mkdir -p ~/actions-runner-ai-incident-commander
cd ~/actions-runner-ai-incident-commander

RUNNER_VERSION=$(gh api repos/actions/runner/releases/latest --jq '.tag_name | ltrimstr("v")')
RUNNER_ASSET="actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz"
RUNNER_SHA=$(gh api repos/actions/runner/releases/latest \
  --jq ".assets[] | select(.name == \"${RUNNER_ASSET}\") | .digest | ltrimstr(\"sha256:\")")
test -n "$RUNNER_SHA"
curl -fsSLO "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_ASSET}"
printf '%s  %s\n' "$RUNNER_SHA" "$RUNNER_ASSET" | shasum -a 256 -c -
tar xzf "$RUNNER_ASSET"
rm "$RUNNER_ASSET"
xattr -dr com.apple.quarantine .
unset RUNNER_SHA RUNNER_ASSET RUNNER_VERSION

REG_TOKEN=$(gh api --method POST \
  /repos/serhii-baksheiev/ai-incident-commander/actions/runners/registration-token \
  --jq .token)
./config.sh \
  --url https://github.com/serhii-baksheiev/ai-incident-commander \
  --token "$REG_TOKEN" \
  --name mac-arm64-01 \
  --labels self-hosted,macOS,ARM64,ai-incident-commander \
  --work _work --unattended --replace
unset REG_TOKEN

./svc.sh install
./svc.sh start
./svc.sh status
```

The runner must report `online` with all four workflow labels before the
workflow reaches `main`:

```bash
gh api /repos/serhii-baksheiev/ai-incident-commander/actions/runners \
  --jq '.runners[] | "\(.name) \(.status) busy=\(.busy) labels=\([.labels[].name] | join(","))"'
```

## Operations

Run service commands from `~/actions-runner-ai-incident-commander`.

| Action | Command |
| --- | --- |
| Status | `./svc.sh status` |
| Restart | `./svc.sh stop && ./svc.sh start` |
| Live logs | `tail -f _diag/Runner_*.log` |
| Stop | `./svc.sh stop` |
| Remove service | `./svc.sh uninstall` |

The LaunchAgent label is
`actions.runner.serhii-baksheiev-ai-incident-commander.mac-arm64-01`. If a job
remains queued, inspect the service status, the runner API's status, busy state
and labels, and the workflow's concurrency state before retrying it.
