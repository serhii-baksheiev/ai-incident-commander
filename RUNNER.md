# Self-hosted GitHub Actions runner

`.github/workflows/ci.yml` runs pull requests and pushes to `main` on a
repository-specific Linux ARM64 runner. The runner lives inside the dedicated
Lima VM `ai-incident-commander-runner`, so CI does not consume GitHub-hosted
minutes and cannot reuse a runner registered to another repository.

## Security boundary

The tracked VM definition `.github/runner/lima.yaml` uses Apple's native `vz`
virtualization with these isolation settings:

```yaml
arch: aarch64
plain: true
mounts: []
propagateProxyEnv: false
ssh:
  loadDotSSHPubKeys: false
  forwardAgent: false
```

Plain mode disables Lima's guest agent and host mounts, and proxy environment
propagation is disabled explicitly. Pull-request code therefore cannot read the
host home, forwarded SSH agent, or host proxy credentials through these sharing
paths. The workflow preflight fails closed if it cannot inspect mounts and
refuses a job if a supported Lima host-share mount type is present at runtime.

The VM does not isolate host network services: the guest can resolve
`host.lima.internal`. Sensitive services on the macOS host must require
authentication or be unreachable from the guest network.

The VM and its runner workspace are persistent. Keep the repository private and
do not allow untrusted users to open runnable pull requests. `contents: read`
and `persist-credentials: false` restrict the job token. Jobs run as the dedicated
non-sudo guest identity `aic-runner`; this reduces guest persistence and privilege
but does not make secrets placed inside the guest safe from a later job.

## Installation

Run this block from the repository root on an Apple Silicon Mac. It installs
Lima with Homebrew, starts the tracked ARM64 VM, downloads the current Linux
ARM64 runner, verifies GitHub's published SHA-256 digest, and registers only
this repository's label set. The registration token is passed to `config.sh`
and unset after configuration; the procedure does not write it to the repository.

```bash
set -euo pipefail

HOMEBREW_NO_AUTO_UPDATE=1 brew install lima
limactl start --name ai-incident-commander-runner --tty=false .github/runner/lima.yaml

RUNNER_VERSION=$(gh api repos/actions/runner/releases/latest --jq '.tag_name | ltrimstr("v")')
RUNNER_ASSET="actions-runner-linux-arm64-${RUNNER_VERSION}.tar.gz"
RUNNER_SHA=$(gh api repos/actions/runner/releases/latest \
  --jq ".assets[] | select(.name == \"${RUNNER_ASSET}\") | .digest | ltrimstr(\"sha256:\")")
REG_TOKEN=$(gh api --method POST \
  /repos/serhii-baksheiev/ai-incident-commander/actions/runners/registration-token \
  --jq .token)
test -n "$RUNNER_SHA"
test -n "$REG_TOKEN"

limactl shell ai-incident-commander-runner -- bash -s -- \
  "$RUNNER_VERSION" "$RUNNER_ASSET" "$RUNNER_SHA" "$REG_TOKEN" <<'GUEST'
set -euo pipefail

runner_version=$1
runner_asset=$2
runner_sha=$3
registration_token=$4

sudo apt-get update
sudo apt-get install -y ca-certificates curl git perl
if ! id -u aic-runner >/dev/null 2>&1; then
  sudo useradd --create-home --shell /bin/bash aic-runner
fi
runner_dir=/home/aic-runner/actions-runner-ai-incident-commander
sudo -H -u aic-runner mkdir -p "$runner_dir"

sudo -H -u aic-runner --chdir="$runner_dir" curl -fsSLO \
  "https://github.com/actions/runner/releases/download/v${runner_version}/${runner_asset}"
printf '%s  %s\n' "$runner_sha" "$runner_asset" | \
  sudo -H -u aic-runner --chdir="$runner_dir" shasum -a 256 -c -
sudo -H -u aic-runner --chdir="$runner_dir" tar xzf "$runner_asset"
sudo -H -u aic-runner --chdir="$runner_dir" rm "$runner_asset"

sudo -H -u aic-runner --chdir="$runner_dir" ./config.sh \
  --url https://github.com/serhii-baksheiev/ai-incident-commander \
  --token "$registration_token" \
  --name linux-arm64-01 \
  --labels self-hosted,Linux,ARM64,ai-incident-commander \
  --work _work --unattended --replace
unset registration_token runner_asset runner_sha runner_version

sudo --chdir="$runner_dir" ./svc.sh install aic-runner
sudo --chdir="$runner_dir" ./svc.sh start
sudo --chdir="$runner_dir" ./svc.sh status
GUEST
unset REG_TOKEN RUNNER_ASSET RUNNER_SHA RUNNER_VERSION
```

Verify the VM boundary and the GitHub registration before merging the workflow:

```bash
limactl list ai-incident-commander-runner
limactl shell ai-incident-commander-runner -- uname -sm
limactl shell ai-incident-commander-runner -- \
  bash -lc 'mount_table=$(findmnt -rn -o FSTYPE,TARGET,SOURCE) &&
    ! grep -Eq "^(virtiofs|9p|fuse\\.sshfs)[[:space:]]" <<<"$mount_table"'
limactl shell ai-incident-commander-runner -- \
  sudo --chdir=/home/aic-runner/actions-runner-ai-incident-commander ./svc.sh status
gh api /repos/serhii-baksheiev/ai-incident-commander/actions/runners \
  --jq '.runners[] | "\(.name) \(.status) busy=\(.busy) labels=\([.labels[].name] | join(","))"'
```

The VM must be `Running`; `uname` must report `Linux aarch64`; the mount probe
must exit successfully without output; and `linux-arm64-01` must report `online`
with `self-hosted,Linux,ARM64,ai-incident-commander`.

## Operations

The runner service is managed inside the VM. Host restart does not weaken the
boundary: start the VM again, then systemd brings the installed service online.

| Action | Command |
| --- | --- |
| VM status | `limactl list ai-incident-commander-runner` |
| Start VM | `limactl start ai-incident-commander-runner` |
| Runner status | `limactl shell ai-incident-commander-runner -- sudo --chdir=/home/aic-runner/actions-runner-ai-incident-commander ./svc.sh status` |
| Restart runner | `limactl shell ai-incident-commander-runner -- bash -lc 'sudo --chdir=/home/aic-runner/actions-runner-ai-incident-commander ./svc.sh stop && sudo --chdir=/home/aic-runner/actions-runner-ai-incident-commander ./svc.sh start'` |
| Live logs | `limactl shell ai-incident-commander-runner -- bash -lc 'sudo tail -f /home/aic-runner/actions-runner-ai-incident-commander/_diag/Runner_*.log'` |
| Stop VM | `limactl stop ai-incident-commander-runner` |

To remove the runner, obtain a fresh removal token on the host, stop and
uninstall the guest service, deregister it, and then delete the VM:

```bash
set -euo pipefail
REMOVE_TOKEN=$(gh api --method POST \
  /repos/serhii-baksheiev/ai-incident-commander/actions/runners/remove-token \
  --jq .token)
limactl shell ai-incident-commander-runner -- bash -s -- "$REMOVE_TOKEN" <<'GUEST'
set -euo pipefail
runner_dir=/home/aic-runner/actions-runner-ai-incident-commander
sudo --chdir="$runner_dir" ./svc.sh stop
sudo --chdir="$runner_dir" ./svc.sh uninstall
sudo -H -u aic-runner --chdir="$runner_dir" ./config.sh remove --token "$1"
GUEST
unset REMOVE_TOKEN
limactl stop ai-incident-commander-runner
limactl delete ai-incident-commander-runner
```
