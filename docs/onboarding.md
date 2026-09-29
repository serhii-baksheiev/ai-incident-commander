# Onboarding on one machine

This is the single-operator way to run the `aic` onboarding commands against a
real PostgreSQL: the Compose stack in `infra/single-user/`. It holds one
PostgreSQL with its data on a named volume, a one-shot `migrate`, and the CLI
run through `docker compose run --rm cli …`. The Incident Lab is available
under the `lab` profile. The stack has no API service, no worker and no UI.

What each command does and prints is in the README's CLI section. This page
covers the stack around the commands.

## Before the first run

You need Docker with Compose v2 and a checkout of this repository. Run every
command from the repository root.

Build the image through `docker compose`, which builds with BuildKit. The
build context is the whole repository, and only BuildKit reads
`infra/single-user/Dockerfile.dockerignore`, the file that keeps `.env` files,
`.git` and `node_modules` out of it.

1. Copy the example variables:

   ```bash
   cp infra/single-user/.env.example infra/single-user/.env
   ```

   Compose reads `infra/single-user/.env` on its own, and `.env` is gitignored.
   The file holds three values, and none of them is a secret:
   - `AIC_DB_PASSWORD_FILE`: the path of a file holding the database password;
   - `AIC_SECRETS_HOST_DIR`: the directory of credential files;
   - `AIC_LAB_HOST_PORT`: the Incident Lab's loopback port.

   Compose reads the lab's definition for every command, so the port must be
   set even when you never start the lab.

2. Create the password file and the credentials directory at those paths.
   The defaults are under `~/.config/aic`, outside the checkout:

   ```bash
   mkdir -p ~/.config/aic/credentials
   (umask 077; openssl rand -base64 24 > ~/.config/aic/db-password)
   ```

   The password reaches PostgreSQL and the CLI as a Docker secret, a file
   mounted inside the container. It is not written into the compose file or
   onto a command line. The CLI's entrypoint reads the file and passes the
   password to the database driver as `PGPASSWORD`, in the environment of the
   CLI process only.

3. Define a shell helper so the commands below stay short:

   ```bash
   aicc() { docker compose --file infra/single-user/compose.yaml "$@"; }
   ```

## Start the database and apply the schema

```bash
aicc up --detach --wait postgres
aicc run --rm migrate
```

The `cli` service waits for `migrate` to complete, so every
`aicc run --rm cli …` applies the schema first. Compose prints the container
start-up lines on stderr, and the command's own JSON lines follow on stdout.

## Register a service

Register it command by command, as the README's CLI section shows:

```bash
aicc run --rm cli service add checkout
aicc run --rm cli doctor
```

Or apply a manifest (the README shows its shape), mounted into the container
read-only:

```bash
aicc run --rm -v "$PWD/onboarding.yaml:/work/onboarding.yaml:ro" \
  cli apply -f /work/onboarding.yaml
```

## Credentials

A `CredentialRef` names a secret; it never holds one. The `cli` service mounts
`AIC_SECRETS_HOST_DIR` read-only at `/run/aic-secrets`, and reads a secret
named `GITHUB_READ_TOKEN` from the file `GITHUB_READ_TOKEN` in that
directory. The container runs as the image's `node` user, so that user must be
able to read the file.

## The Incident Lab

```bash
aicc --profile lab up --detach --wait lab-api
```

This starts `lab-api`, `payments` and `inventory`. Inside the Compose network
the lab API is `http://lab-api:3000`, so a lab source is bound as:

```yaml
sources:
  - name: lab
    adapter: lab@1
    config:
      baseUrl: http://lab-api:3000
```

After that, `aicc run --rm cli source check checkout <env>` reports the
binding `ready`.

## Stop, and start over

```bash
aicc --profile lab --profile cli down              # keeps the registry
aicc --profile lab --profile cli down --volumes    # deletes the registry
```

The registry lives on the `aic-postgres-data` volume, so `down --volumes`
deletes every registered service, environment, source, policy and incident.
