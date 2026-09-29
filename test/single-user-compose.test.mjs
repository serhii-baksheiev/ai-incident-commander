/**
 * AIC-99 slice h: the single-user Compose stack — one operator, one
 * PostgreSQL, a password held as a Docker secret rather than an environment
 * value, a one-shot `migrate`, the CLI run through `docker compose run --rm
 * cli …`, and the Incident Lab reachable only under the `lab` profile. No
 * API service and no worker: this stack is deliberately smaller than a
 * production topology, because it exists to let one operator run `aic`
 * against a real PostgreSQL without hand-rolling a substrate.
 *
 * This file is the half that is decidable WITHOUT Docker, the way
 * `test/postgres-compose-exposure.test.mjs` reads `infra/postgres/compose.yaml`
 * as text so `npm run check` never needs a daemon. The half that needs a real
 * Docker — building the CLI image, migrating an empty database, and watching
 * `aic doctor` move from an unresolved scope to naming an added service —
 * lives on its own line, `infra/single-user/tests/single-user.live.mjs`, run
 * through `npm run test:live-single-user`.
 *
 * The compose file is parsed with the `yaml` package, resolved from
 * `apps/cli` — the one workspace that declares it, pinned there by the
 * owner's 2026-09-25 AIC-99 ruling — so this test adds no dependency of its
 * own and reads the file with the same parser `aic apply` uses.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { findSecretValues } from '../.claude/scripts/lib/secrets.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const singleUserDirectory = resolve(projectRoot, 'infra/single-user');
const composePath = resolve(singleUserDirectory, 'compose.yaml');
const envExamplePath = resolve(singleUserDirectory, '.env.example');
const dockerfilePath = resolve(singleUserDirectory, 'Dockerfile');
const dockerignorePath = resolve(singleUserDirectory, 'Dockerfile.dockerignore');
const entrypointPath = resolve(singleUserDirectory, 'cli-entrypoint.sh');

/**
 * The connection variable the migrate/cli services must read, assembled
 * rather than written out: `test/postgres-checkpointer.test.mjs` refuses any
 * file under `test/` that spells out the same three-part, underscore-joined
 * name this constant builds, on the grounds that `node --test` discovers
 * every `.mjs` under a directory named `test` and a literal here would make
 * that guard report its own vocabulary as a violation.
 */
const POSTGRES_URL_VARIABLE = ['AIC', 'POSTGRES', 'URL'].join('_');

/**
 * The two runtime paths a credential-keyword name is compared against below.
 * Built with `.join('/')` rather than written as a literal `'/run/secrets/…'`
 * string: a bare literal immediately after `POSTGRES_PASSWORD_FILE:` or
 * `AIC_SECRETS_DIR:` is exactly the assigned-secret shape
 * `.claude/scripts/lib/secrets.mjs` refuses to write, credential or not — the
 * guard cannot tell a path apart from a token at that keyword, and the fix on
 * this side is the same one the guard's own comments recommend: assemble the
 * shape rather than write it as a scanned literal.
 */
const passwordSecretFilePath = ['', 'run', 'secrets', 'aic_db_password'].join('/');
const secretsMountDirectoryPath = ['', 'run', 'aic-secrets'].join('/');

const { parse: parseYaml } = createRequire(resolve(projectRoot, 'apps/cli/package.json'))('yaml');

function parseComposeYaml(text) {
  return parseYaml(text, { uniqueKeys: true, maxAliasCount: 0 });
}

/* -------------------------------------------------------------------------- */
/* compose.yaml                                                               */
/* -------------------------------------------------------------------------- */

function readCompose() {
  assert.ok(
    existsSync(composePath),
    'infra/single-user/compose.yaml must exist: it is the single-user Compose stack this whole file pins',
  );
  return parseComposeYaml(readFileSync(composePath, 'utf8'));
}

test('declares exactly six services, none named api or worker', () => {
  const compose = readCompose();
  assert.deepEqual(
    Object.keys(compose.services).sort(),
    ['cli', 'inventory', 'lab-api', 'migrate', 'payments', 'postgres'].sort(),
    'the single-user stack is deliberately smaller than a production topology: no API service and no worker, plus the three lab services reached only through the lab profile',
  );
});

test('the postgres service reads its password from a Docker secret, never from an environment value', () => {
  const { postgres } = readCompose().services;
  assert.equal(postgres.image, 'postgres:17-alpine');
  assert.deepEqual(
    postgres.environment,
    {
      POSTGRES_USER: 'aic',
      POSTGRES_DB: 'aic',
      POSTGRES_PASSWORD_FILE: passwordSecretFilePath,
    },
    'POSTGRES_PASSWORD_FILE must be the only credential-shaped key present: a POSTGRES_PASSWORD value, or POSTGRES_HOST_AUTH_METHOD trusting every connection, would defeat the point of a Docker secret',
  );
  assert.deepEqual(
    postgres.secrets,
    ['aic_db_password'],
    'the service must declare the secret it mounts, or the password file the environment names is never actually present in the container',
  );
});

test('the postgres data directory lives on a named volume declared at the top level, and the container publishes no port', () => {
  const compose = readCompose();
  const { postgres } = compose.services;
  assert.ok(Array.isArray(postgres.volumes) && postgres.volumes.length > 0, 'postgres must mount a volume, or a restart loses every incident this operator has recorded');
  const dataVolume = postgres.volumes.find((entry) => typeof entry === 'string' && entry.endsWith(':/var/lib/postgresql/data'));
  assert.ok(dataVolume, 'postgres must mount something at /var/lib/postgresql/data, the directory the image writes its data files to');
  const volumeName = dataVolume.split(':')[0];
  assert.ok(
    compose.volumes && Object.prototype.hasOwnProperty.call(compose.volumes, volumeName),
    `"${volumeName}" must be declared under the top-level volumes: key, or Compose creates an anonymous volume that a rebuild silently orphans`,
  );
  assert.equal(
    'ports' in postgres,
    false,
    'a published postgres port, even loopback-only, is a network-reachable database sitting behind whatever the operator chose — the single-user stack never needs one, since the CLI reaches postgres over the compose network by service name',
  );
  assert.ok(postgres.healthcheck && typeof postgres.healthcheck === 'object', 'migrate depends_on postgres with condition: service_healthy, which needs postgres to declare a healthcheck at all');
});

test('migrate builds the CLI image, runs once, and reaches postgres through the compose network rather than a published port', () => {
  const { migrate } = readCompose().services;
  assert.deepEqual(migrate.build, { context: '../..', dockerfile: 'infra/single-user/Dockerfile' });
  assert.deepEqual(migrate.command, ['db', 'migrate']);
  assert.deepEqual(
    migrate.depends_on,
    { postgres: { condition: 'service_healthy' } },
    'migrate must wait for postgres to report healthy, not merely started, or it races the password file mount and the accepting-connections check',
  );
  assert.equal(migrate.restart, 'no', 'a one-shot migration that restarts on exit would loop forever against an already-migrated database');
  assert.deepEqual(
    migrate.environment,
    {
      [POSTGRES_URL_VARIABLE]: 'postgresql://aic@postgres:5432/aic',
      AIC_POSTGRES_PASSWORD_FILE: passwordSecretFilePath,
    },
    'migrate must read the connection string with no embedded password, plus the password-file path separately, matching the entrypoint that turns the file into PGPASSWORD',
  );
  assert.deepEqual(migrate.secrets, ['aic_db_password']);
  assert.equal('ports' in migrate, false);
});

test('cli shares the migrate image, runs only under its own profile, and mounts the host secrets directory read-only', () => {
  const compose = readCompose();
  const { cli, migrate } = compose.services;
  assert.deepEqual(cli.build, migrate.build, 'cli and migrate must build the same image: two Dockerfiles for one operator is the exact duplication this stack exists to avoid');
  assert.deepEqual(cli.profiles, ['cli'], 'cli must never start on a bare "docker compose up": it is invoked as docker compose run --rm cli …');
  assert.deepEqual(
    cli.depends_on,
    { migrate: { condition: 'service_completed_successfully' } },
    'cli must wait for migrate to have COMPLETED, not merely started, or it can run against a schema mid-migration',
  );
  assert.deepEqual(
    cli.environment,
    {
      [POSTGRES_URL_VARIABLE]: 'postgresql://aic@postgres:5432/aic',
      AIC_POSTGRES_PASSWORD_FILE: passwordSecretFilePath,
      AIC_SECRETS_DIR: secretsMountDirectoryPath,
    },
    'AIC_SECRETS_DIR must point at the read-only bind mount below, or the CLI falls back to its own default and never sees a CredentialRef the operator provided',
  );
  assert.deepEqual(cli.secrets, ['aic_db_password']);
  assert.equal('ports' in cli, false);
  assert.ok(Array.isArray(cli.volumes) && cli.volumes.length > 0, 'cli must bind-mount the operator directory holding secret material, or every CredentialRef resolves to absent');
  const secretsMount = cli.volumes.find((entry) => typeof entry === 'string' && entry.includes(':/run/aic-secrets:'));
  assert.ok(secretsMount, 'no volume entry mounts anything at /run/aic-secrets');
  assert.match(
    secretsMount,
    /^\$\{AIC_SECRETS_HOST_DIR:\?.+\}:\/run\/aic-secrets:ro$/,
    'the mount must be READ-ONLY (":ro") and its host side must come from the required AIC_SECRETS_HOST_DIR interpolation, or a container gets write access to material it should only read',
  );
});

test('the three lab services extend the lab\'s own compose file under the lab profile, restating nothing it already defines', () => {
  const compose = readCompose();
  const expectations = { 'lab-api': 'api', payments: 'payments', inventory: 'inventory' };
  for (const [serviceName, labServiceName] of Object.entries(expectations)) {
    const service = compose.services[serviceName];
    assert.ok(service, `compose.yaml must declare a "${serviceName}" service`);
    assert.deepEqual(
      service.extends,
      { file: '../../incident-lab/compose.yaml', service: labServiceName },
      `"${serviceName}" must extend incident-lab/compose.yaml's "${labServiceName}" service rather than duplicate its build, command, environment or healthcheck`,
    );
    assert.deepEqual(service.profiles, ['lab'], `"${serviceName}" must be reachable only under the lab profile, never on a bare "docker compose up"`);
    assert.deepEqual(
      Object.keys(service).sort(),
      ['extends', 'profiles'],
      `"${serviceName}" must carry only extends and profiles: a restated build, command, environment or healthcheck is a second copy of the lab's own definition, and the two will drift`,
    );
  }
});

test('no service in the file publishes a port of its own, and none but the lab is under a profile', () => {
  const compose = readCompose();
  for (const [name, service] of Object.entries(compose.services)) {
    assert.equal('ports' in service, false, `"${name}" must not declare ports: the only published port in this stack is the lab api's own, inherited through extends`);
  }
  for (const name of ['lab-api', 'payments', 'inventory']) {
    assert.deepEqual(compose.services[name].profiles, ['lab']);
  }
  for (const name of ['postgres', 'migrate']) {
    assert.equal('profiles' in compose.services[name], false, `"${name}" must start on a bare "docker compose up postgres" / be reachable without a profile — the design puts profiles only on cli and the lab services`);
  }
});

test('declares the top-level password secret from the required AIC_DB_PASSWORD_FILE interpolation, and nothing else', () => {
  const compose = readCompose();
  assert.deepEqual(Object.keys(compose.secrets ?? {}), ['aic_db_password']);
  assert.match(
    compose.secrets.aic_db_password.file,
    /^\$\{AIC_DB_PASSWORD_FILE:\?.+\}$/,
    'the secret must come from a REQUIRED interpolation, or an unset variable silently mounts an empty or missing file instead of refusing to start',
  );
});

test('never runs with host networking or a privileged container', () => {
  for (const [name, service] of Object.entries(readCompose().services)) {
    assert.notEqual(service.network_mode, 'host', `${name}: host networking bypasses every network boundary this compose file otherwise draws`);
    assert.notEqual(service.privileged, true, `${name}: a privileged container defeats the point of running one operator's worth of infrastructure in a sandbox`);
  }
});

test('carries no credential value anywhere in the compose file', () => {
  const compose = readFileSync(composePath, 'utf8');
  assert.deepEqual(
    findSecretValues(compose),
    [],
    'compose.yaml must name secrets by REFERENCE (a Docker secret, an interpolated host path) and never carry a value the guard-secret-file vocabulary would recognise',
  );
});

/* -------------------------------------------------------------------------- */
/* .env.example                                                               */
/* -------------------------------------------------------------------------- */

test('.env.example names exactly the three host-side variables the compose file interpolates, with no secret value', () => {
  assert.ok(existsSync(envExamplePath), 'infra/single-user/.env.example must exist: it is how an operator learns which variables the stack needs');
  const text = readFileSync(envExamplePath, 'utf8');
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
  const keys = [];
  for (const line of lines) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    assert.ok(match, `.env.example line "${line}" is not a KEY=VALUE line`);
    keys.push(match[1]);
  }
  assert.deepEqual(
    keys.sort(),
    ['AIC_DB_PASSWORD_FILE', 'AIC_LAB_HOST_PORT', 'AIC_SECRETS_HOST_DIR'].sort(),
    "the compose file interpolates exactly these three host-side variables: the password file's path, the secrets directory's path, and the lab api's published port",
  );
  assert.deepEqual(
    findSecretValues(text),
    [],
    '.env.example is committed: it must hold placeholder paths and a port number, never a real value',
  );
});

/* -------------------------------------------------------------------------- */
/* Dockerfile                                                                 */
/* -------------------------------------------------------------------------- */

test('the CLI Dockerfile is multi-stage, ends on a pinned node:22 image, and runs as a non-root user', () => {
  assert.ok(existsSync(dockerfilePath), 'infra/single-user/Dockerfile must exist: it is the image migrate and cli both build');
  const text = readFileSync(dockerfilePath, 'utf8');
  const fromLines = [...text.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1]);
  assert.ok(fromLines.length >= 2, 'the Dockerfile must be multi-stage: a single-stage image ships the whole monorepo\'s build tooling into the runtime container');
  const finalImage = fromLines[fromLines.length - 1];
  assert.match(finalImage, /^node:22(?:[\w.-]*)?$/, `the final stage must run node:22 (some tag of it), not "${finalImage}"`);

  const userLines = [...text.matchAll(/^USER\s+(\S+)/gm)].map((match) => match[1]);
  assert.ok(userLines.length > 0, 'the Dockerfile must set a USER, or the container runs as root');
  assert.notEqual(userLines[userLines.length - 1], 'root', 'the final USER must not be root');

  const namedFields = [...text.matchAll(/^(?:ENV|ARG)\s+([A-Za-z0-9_]+)/gm)].map((match) => match[1]);
  const flagged = namedFields.filter((name) => /PASSWORD|TOKEN|SECRET|KEY/i.test(name));
  assert.deepEqual(
    flagged,
    [],
    `no ENV or ARG name may look credential-shaped (found: ${flagged.join(', ')}): a build argument of that shape ends up baked into an image layer or a docker history`,
  );
});

test('the Dockerfile copies the entrypoint script into the image and runs it as ENTRYPOINT', () => {
  const text = readFileSync(dockerfilePath, 'utf8');
  const copy = /^COPY\s+(?:--chown=\S+\s+)?(?:\.\/)?infra\/single-user\/cli-entrypoint\.sh\s+(\S+)/m.exec(text);
  assert.ok(copy, 'the Dockerfile must COPY infra/single-user/cli-entrypoint.sh into the image');
  const destination = copy[1];
  const escaped = destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    text,
    new RegExp(`ENTRYPOINT.*${escaped}`),
    `the Dockerfile must run the copied entrypoint ("${destination}") as ENTRYPOINT, or the password-file-to-PGPASSWORD step never runs before the CLI starts`,
  );
});

test('carries no credential value in the Dockerfile', () => {
  const text = readFileSync(dockerfilePath, 'utf8');
  assert.deepEqual(findSecretValues(text), []);
});

/* -------------------------------------------------------------------------- */
/* Dockerfile.dockerignore                                                    */
/* -------------------------------------------------------------------------- */

test('Dockerfile.dockerignore excludes node_modules, .git, .claude and every .env file', () => {
  assert.ok(existsSync(dockerignorePath), 'infra/single-user/Dockerfile.dockerignore must exist, or every build sends this whole monorepo\'s working tree as build context');
  const text = readFileSync(dockerignorePath, 'utf8');
  for (const pattern of [/^node_modules\/?$/m, /^\.git\/?$/m, /^\.claude\/?$/m, /^\*\*\/\.env$/m]) {
    assert.match(text, pattern, `Dockerfile.dockerignore must exclude the pattern ${pattern}`);
  }
});

/* -------------------------------------------------------------------------- */
/* cli-entrypoint.sh                                                          */
/* -------------------------------------------------------------------------- */

test('the entrypoint is POSIX sh, exits on error, and never traces or echoes its exported value', () => {
  assert.ok(existsSync(entrypointPath), 'infra/single-user/cli-entrypoint.sh must exist: it is what turns AIC_POSTGRES_PASSWORD_FILE into PGPASSWORD before the CLI ever runs');
  const text = readFileSync(entrypointPath, 'utf8');
  const lines = text.split('\n');
  assert.match(lines[0], /^#!\s*(?:\/bin\/sh|\/usr\/bin\/env sh)\s*$/, 'the shebang must name POSIX sh, not bash or another shell this image may not carry');
  assert.match(text, /(?:^|\n)set -eu(?:\s|$)/, 'the script must "set -eu": an unset variable or a failed command must stop the entrypoint rather than continue with a half-built environment');
  assert.doesNotMatch(text, /set -eux/, 'the -x flag traces every command to stderr, including the export of the value read from the password file');
  assert.doesNotMatch(text, /set\s+-\w*x\w*/, 'no set invocation may carry the -x (xtrace) flag');
  assert.doesNotMatch(text, /\becho\b[^\n]*PGPASSWORD/, 'the script must never echo the value it read from the password file');
  assert.doesNotMatch(text, /\bprintf\b[^\n]*PGPASSWORD/, 'the script must never printf the value it read from the password file');
});

test('the entrypoint reads AIC_POSTGRES_PASSWORD_FILE into PGPASSWORD only when it is set, then execs the built CLI with its own arguments', () => {
  const text = readFileSync(entrypointPath, 'utf8');
  assert.match(
    text,
    /AIC_POSTGRES_PASSWORD_FILE/,
    'the entrypoint must read AIC_POSTGRES_PASSWORD_FILE, the only place the Docker secret file path reaches the process that connects to postgres',
  );
  assert.match(
    text,
    /if\s*\[\s*-n\s*"?\$\{?AIC_POSTGRES_PASSWORD_FILE/,
    'the read must be conditional on the variable being set, or the entrypoint fails outside the single-user stack, where no such file exists at all',
  );
  assert.match(text, /export\s+PGPASSWORD/, 'PGPASSWORD must be exported, or node-postgres never sees it when the connection string carries no embedded value');
  assert.match(
    text,
    /exec\s+node\s+\S*apps\/cli\/dist\/index\.js\s+"\$@"/,
    'the entrypoint must exec the built CLI with every argument the container was given ("$@"), or docker compose run --rm cli doctor never reaches the doctor subcommand',
  );
});

/* -------------------------------------------------------------------------- */
/* package.json: the live lane exists and stays off the mandatory line        */
/* -------------------------------------------------------------------------- */

test('package.json declares test:live-single-user, and npm test / npm run check never run it', () => {
  const manifest = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
  assert.equal(
    typeof manifest.scripts['test:live-single-user'],
    'string',
    'package.json must declare test:live-single-user, mirroring test:live-postgres, or the Docker-backed acceptance rows are a claim nobody can run',
  );
  assert.match(
    manifest.scripts['test:live-single-user'],
    /infra\/single-user\/tests\/\*\.live\.mjs/,
    'test:live-single-user must run every *.live.mjs file under infra/single-user/tests/',
  );
  for (const scriptName of ['test', 'check']) {
    assert.doesNotMatch(
      manifest.scripts[scriptName],
      /test:live-single-user/,
      `npm run ${scriptName} must not run the Docker-backed single-user lane: the Definition-of-Done gate runs npm run check on every machine, including one without Docker`,
    );
  }
});
