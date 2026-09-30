#!/usr/bin/env node

import { parseArgs } from 'node:util';

import { randomUUID } from 'node:crypto';

import { createDirectorySecretResolver } from '@aic/tools';
import {
  assertCheckpointerSchemaVersion,
  createFencedCheckpointer,
  createIncidentStore,
  createPostgresCheckpointer,
  createRegistryStore,
  createRunStore,
  openRunWriteContext,
  setupApplicationSchema,
  type CheckpointerVersionSource,
  type RegistryStore,
  type RunClaim,
  type RunStore,
} from '@aic/persistence';

import { runRegistryCommand, type RegistryCommandDeps } from './commands/registry.js';
import { runIncidentCommand, type IncidentCommandStore } from './commands/incident.js';
import {
  CheckpointerNotProvisionedError,
  HEARTBEAT_INTERVAL_MS,
  runIncidentInvestigateCommand,
  type IncidentInvestigateWriteContext,
} from './commands/incident-investigate.js';
import { runApplyCommand } from './commands/apply.js';
import { runDevSpike } from './commands/dev-spike.js';
import { runInvestigate } from './commands/investigate.js';
import { runSourceCheckCommand } from './commands/source-check.js';
import { runDoctorCommand } from './commands/doctor.js';

// The onboarding nouns docs/decisions/integration-boundary.md's Terminology
// section fixes for AIC-99. `doctor` and `source check` stop being stubs in
// slice e, `incident` (its `start` subcommand) in slice f, `apply` in slice
// g — see runDoctorCommand, runSourceCheckCommand, runIncidentCommand and
// runApplyCommand below. No onboarding noun remains a stub.
const STUB_NOUNS = [] as const;
type StubNoun = (typeof STUB_NOUNS)[number];

// AIC-99 slice d: real dispatch over the registry store — `credential` is a
// new noun for the ADR addendum term CredentialRef. `source`'s own `check`
// subcommand stays a stub (handled separately below); its `add` subcommand
// is real.
const REGISTRY_NOUNS = ['service', 'env', 'source', 'policy', 'credential'] as const;
type RegistryNoun = (typeof REGISTRY_NOUNS)[number];

const generalHelp = `AI Incident Commander

Usage: aic <command> [options]

Commands:
  service      Register and manage a Service AIC investigates
  env          Register and manage a Service's Environments
  source       Register and check evidence SourceBindings
  credential   Register a CredentialRef (a secret NAME, never its value)
  policy       Set the ActionPolicy for an Environment
  incident     Record an Incident for a scope, or investigate one
  investigate  Run one investigation over a replay file
  doctor       Check onboarding health
  apply        Apply a declarative onboarding manifest
  db           Manage the aic_app application schema (e.g. "aic db migrate")

Run "aic dev spike --help" for the development-only persistence spike.
Run "aic investigate --help" for the replay-driven investigation runner.`;

function isStubNoun(value: string): value is StubNoun {
  return (STUB_NOUNS as readonly string[]).includes(value);
}

function isRegistryNoun(value: string): value is RegistryNoun {
  return (REGISTRY_NOUNS as readonly string[]).includes(value);
}

const POSTGRES_URL_VARIABLE = 'AIC_POSTGRES_URL';

function requirePostgresUrl(env: NodeJS.ProcessEnv): string {
  const value = env[POSTGRES_URL_VARIABLE];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${POSTGRES_URL_VARIABLE} must be set to a PostgreSQL connection string`);
  }
  return value;
}

/**
 * Every `RegistryStore` method, wrapped so `AIC_POSTGRES_URL` is read only
 * when a method is actually called — never merely because a registry noun
 * was dispatched. This is what lets a parse error (missing/unknown
 * subcommand, a bad flag) refuse before `AIC_POSTGRES_URL` is ever read: the
 * argv parsing inside `runRegistryCommand` always runs first and, on
 * failure, never calls a store method at all.
 *
 * `@aic/persistence`'s `createRegistryStore` accepts a bare connection
 * string for exactly this caller: given one, it opens its own `Pool` per
 * call, checks the schema version, runs, and closes it again — so this app
 * never imports `pg` itself (`.claude/rules/invariants.md`, "one mechanism,
 * one implementation": the PostgreSQL driver stays inside
 * `packages/persistence`).
 * see test/postgres-checkpointer.test.mjs › "keeps checkpointer storage,
 * the application schema's tables, and the PostgreSQL driver out of every
 * layer but persistence"
 * see cli-dispatcher.test.mjs › "the "service" noun with no subcommand exits
 * non-zero, names "subcommand" as the problem rather than claiming to be
 * unimplemented, and writes nothing to the working directory" (spawned with
 * no connection string at all; one row per registry noun)
 */
function createConnectedRegistryStore(env: NodeJS.ProcessEnv): RegistryStore {
  const connected = (): RegistryStore => createRegistryStore(requirePostgresUrl(env));
  return {
    snapshot: () => connected().snapshot(),
    addService: (input) => connected().addService(input),
    addEnvironment: (input) => connected().addEnvironment(input),
    addCredentialRef: (input) => connected().addCredentialRef(input),
    addSourceBinding: (input) => connected().addSourceBinding(input),
    setActionPolicy: (input) => connected().setActionPolicy(input),
    removeEnvironment: (input) => connected().removeEnvironment(input),
    removeService: (input) => connected().removeService(input),
  };
}

/**
 * AIC-99 slice f: `aic incident start`'s own store — `snapshot()` (to resolve
 * `<service>`/`<env>` names, reusing `createConnectedRegistryStore` above)
 * plus `startIncident` (`@aic/persistence`'s `createIncidentStore`), built
 * fresh per call so `AIC_POSTGRES_URL` is read only when a method is
 * actually called — the same lazy convention `createConnectedRegistryStore`
 * follows.
 */
function createConnectedIncidentStore(env: NodeJS.ProcessEnv): IncidentCommandStore {
  return {
    snapshot: () => createConnectedRegistryStore(env).snapshot(),
    startIncident: (intake, opts) => createIncidentStore(requirePostgresUrl(env)).startIncident(intake, opts),
  };
}

/**
 * AIC-146 c4b: `aic incident investigate`'s own `RunStore` session — ONE
 * store (one `pg.Pool`), built lazily on the first call any of its methods
 * makes, so a parse refusal (bad argv, missing `--roles`, no model
 * credential) still never reads `AIC_POSTGRES_URL` — the same lazy
 * convention `createConnectedRegistryStore` follows above. Unlike that
 * helper's per-call open/close pattern, this pool has to survive the WHOLE
 * command — the heartbeat keeps renewing the same lease, and the write
 * context keeps reusing the same pool for every commit — so the caller
 * closes it once with `.close()` after the command settles.
 */
function createConnectedRunSession(env: NodeJS.ProcessEnv) {
  let store: RunStore | undefined;
  const ensure = (): RunStore => {
    store ??= createRunStore(requirePostgresUrl(env), {
      leaseMs: HEARTBEAT_INTERVAL_MS * 3,
      maxExecutionAttempts: 5,
    });
    return store;
  };
  return {
    runs: {
      getRun: (runId: string) => ensure().getRun(runId),
      createRun: (run: { runId: string; input: unknown }) => ensure().createRun(run),
      claimRun: (runId: string, workerId: string) => ensure().claimRun(runId, workerId),
      sweepExpired: () => ensure().sweepExpired(),
      renewLease: (claim: RunClaim) => ensure().renewLease(claim),
    },
    openWriteContext: (claim: RunClaim) => openRunWriteContext(ensure(), claim),
    versionSource: (): CheckpointerVersionSource => ensure().pool,
    close: async (): Promise<void> => {
      if (store !== undefined) await store.close();
    },
  };
}

/** PostgreSQL's undefined_table SQLSTATE. */
const UNDEFINED_TABLE = '42P01';

/**
 * The checkpointer half of the same command: the PostgreSQL checkpointer,
 * schema-version-checked first (AIC-55) through the run session's own pool,
 * fenced by the run's write context on every path but the read-only "already
 * completed" one, which passes no context. Only a missing checkpointer table
 * becomes `CheckpointerNotProvisionedError` (which the command refuses as
 * `checkpointer-not-provisioned`); a version mismatch or a connection failure
 * propagates as itself. Every saver built is ended by `closeAll`, so its pool
 * does not outlive the command.
 */

function createConnectedCheckpointers(env: NodeJS.ProcessEnv, versionSource: () => CheckpointerVersionSource) {
  const savers: Array<ReturnType<typeof createPostgresCheckpointer>> = [];
  return {
    create: async (context?: IncidentInvestigateWriteContext) => {
      try {
        await assertCheckpointerSchemaVersion(versionSource());
      } catch (error) {
        // PostgreSQL's undefined_table: no checkpointer schema in this
        // database at all. Anything else (a version mismatch, a connection
        // failure) is reported as itself.
        if ((error as { code?: unknown } | null)?.code === UNDEFINED_TABLE) {
          throw new CheckpointerNotProvisionedError({ cause: error });
        }
        throw error;
      }
      const saver = createPostgresCheckpointer(requirePostgresUrl(env));
      savers.push(saver);
      return context === undefined ? saver : createFencedCheckpointer(saver, context);
    },
    closeAll: async (): Promise<void> => {
      await Promise.all(savers.map((saver) => saver.end()));
    },
  };
}

const SECRETS_DIR_VARIABLE = 'AIC_SECRETS_DIR';
const DEFAULT_SECRETS_DIR = '/run/secrets';

/**
 * AIC-99 slice e: the directory a resolved `CredentialRef.secretName` is read
 * from — `AIC_SECRETS_DIR`, defaulting to `/run/secrets`. Built fresh per
 * dispatch (never at module load), so a parse error still refuses before any
 * filesystem path is even computed, mirroring `createConnectedRegistryStore`
 * above.
 */
function createSecretResolver(env: NodeJS.ProcessEnv) {
  const configured = env[SECRETS_DIR_VARIABLE];
  const directory = typeof configured === 'string' && configured.trim() !== '' ? configured : DEFAULT_SECRETS_DIR;
  return createDirectorySecretResolver({ directory });
}

/**
 * Finds the next positional argument in `argv` and the raw remainder of
 * `argv` after it, using `node:util`'s `parseArgs` tokenizer only to locate
 * that argument's index — never its interpretation of the tokens around it.
 * `parseArgs` with no declared options treats an unrecognised `--flag value`
 * pair as a boolean flag plus a *separate* positional, which would corrupt
 * passthrough to a subcommand that expects `--run-id <id>` intact. Slicing
 * the original `argv` by index sidesteps that: whatever follows the found
 * positional reaches the subcommand byte-for-byte.
 */
function nextPositional(argv: readonly string[]): { command: string | undefined; rest: string[] } {
  const { tokens } = parseArgs({ args: argv, strict: false, allowPositionals: true, tokens: true });
  const first = tokens.find((token) => token.kind === 'positional');
  if (!first) {
    return { command: undefined, rest: [] };
  }
  return { command: first.value, rest: argv.slice(first.index + 1) };
}

function runOnboardingStub(noun: string): void {
  process.stderr.write(`aic: "${noun}" is not implemented in this build.\n`);
  process.exitCode = 1;
}

function writeStdoutLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function main(argv: readonly string[]): Promise<void> {
  const { command, rest } = nextPositional(argv);

  if (command === undefined) {
    process.stdout.write(`${generalHelp}\n`);
    return;
  }

  if (command === 'dev') {
    const { command: sub, rest: devArgs } = nextPositional(rest);
    if (sub !== 'spike') {
      // Fixed text: never reproduces the given subcommand token (carried
      // from #172 security-scanner r2).
      throw new Error('unknown command: dev <subcommand>');
    }
    await runDevSpike(devArgs);
    return;
  }

  if (command === 'investigate') {
    await runInvestigate(rest);
    return;
  }

  if (command === 'start' || command === 'resume') {
    process.stderr.write(`aic: "${command}" moved to \`aic dev spike ${command}\`.\n`);
    process.exitCode = 1;
    return;
  }

  if (command === 'db') {
    // A getter, so the connection variable is read only once the subcommand
    // is known to be `migrate`: a bad subcommand is refused as such.
    const deps: RegistryCommandDeps = {
      stdout: writeStdoutLine,
      setupApplicationSchema,
      get connectionString() {
        return requirePostgresUrl(process.env);
      },
    };
    await runRegistryCommand('db', rest, deps);
    return;
  }

  if (command === 'doctor') {
    const resolver = createSecretResolver(process.env);
    const summary = await runDoctorCommand(rest, {
      store: createConnectedRegistryStore(process.env),
      resolveSecret: (secretName) => resolver.resolve(secretName),
      stdout: writeStdoutLine,
    });
    if (!summary.allReady) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'incident') {
    const { command: sub, rest: incidentRest } = nextPositional(rest);
    if (sub === 'start') {
      await runIncidentCommand(incidentRest, {
        store: createConnectedIncidentStore(process.env),
        stdout: writeStdoutLine,
        now: () => new Date().toISOString(),
        generateId: randomUUID,
      });
      return;
    }
    if (sub === 'investigate') {
      const session = createConnectedRunSession(process.env);
      const checkpointers = createConnectedCheckpointers(process.env, session.versionSource);
      try {
        await runIncidentInvestigateCommand(incidentRest, {
          env: process.env,
          registry: createConnectedRegistryStore(process.env),
          incidents: {
            getIncident: (id) => createIncidentStore(requirePostgresUrl(process.env)).getIncident(id),
          },
          runs: session.runs,
          openWriteContext: session.openWriteContext,
          createCheckpointer: (context) => checkpointers.create(context),
          fetch: globalThis.fetch,
          resolveSecret: (secretName) => createSecretResolver(process.env).resolve(secretName),
          workerId: `aic-cli-${randomUUID()}`,
          stdout: writeStdoutLine,
          now: () => new Date().toISOString(),
        });
      } finally {
        try {
          await checkpointers.closeAll();
        } finally {
          await session.close();
        }
      }
      return;
    }
    // Fixed text: "incident" itself is implemented in this slice, so this
    // is a subcommand problem, never the "not implemented" stub wording.
    throw new Error('aic incident requires a subcommand: one of start, investigate');
  }

  if (command === 'apply') {
    const result = await runApplyCommand(rest, {
      store: createConnectedRegistryStore(process.env),
      stdout: writeStdoutLine,
    });
    if (!result.clean) {
      process.exitCode = 1;
    }
    return;
  }

  if (isRegistryNoun(command)) {
    // AIC-99 slice e: `source check` is real; only `source add` (and the
    // other registry nouns' own subcommands) share this branch with it.
    if (command === 'source') {
      const { command: sourceSub, rest: sourceRest } = nextPositional(rest);
      if (sourceSub === 'check') {
        const resolver = createSecretResolver(process.env);
        const summary = await runSourceCheckCommand(sourceRest, {
          store: createConnectedRegistryStore(process.env),
          resolveSecret: (secretName) => resolver.resolve(secretName),
          stdout: writeStdoutLine,
        });
        if (!summary.allReady) {
          process.exitCode = 1;
        }
        return;
      }
    }
    const deps: RegistryCommandDeps = {
      store: createConnectedRegistryStore(process.env),
      stdout: writeStdoutLine,
    };
    await runRegistryCommand(command, rest, deps);
    return;
  }

  if (isStubNoun(command)) {
    runOnboardingStub(command);
    return;
  }

  // Fixed text: never reproduces the given command token (carried from #172
  // security-scanner r2).
  throw new Error('unknown command');
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`aic: ${message}\n`);
  process.exitCode = 1;
});
