#!/usr/bin/env node

import { parseArgs } from 'node:util';

import { randomUUID } from 'node:crypto';

import { createIncidentStore, setupApplicationSchema } from '@aic/persistence';

import { createConnectedRegistryStore, createSecretResolver, requirePostgresUrl } from './commands/connected-env.js';
import { runRegistryCommand, type RegistryCommandDeps } from './commands/registry.js';
import { runIncidentCommand, type IncidentCommandStore } from './commands/incident.js';
import { runIncidentInvestigateCommand } from './commands/incident-investigate.js';
import { createIncidentInvestigateDeps } from './commands/incident-investigate-deps.js';
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

/**
 * AIC-99 slice f: `aic incident start`'s own store — `snapshot()` (to resolve
 * `<service>`/`<env>` names, reusing `createConnectedRegistryStore` from
 * `./commands/connected-env.js`) plus `startIncident` (`@aic/persistence`'s
 * `createIncidentStore`), built fresh per call so `AIC_POSTGRES_URL` is read
 * only when a method is actually called — the same lazy convention
 * `createConnectedRegistryStore` follows.
 */
function createConnectedIncidentStore(env: NodeJS.ProcessEnv): IncidentCommandStore {
  return {
    snapshot: () => createConnectedRegistryStore(env).snapshot(),
    startIncident: (intake, opts) => createIncidentStore(requirePostgresUrl(env)).startIncident(intake, opts),
  };
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
      const { deps, close } = createIncidentInvestigateDeps(process.env, { stdout: writeStdoutLine });
      try {
        await runIncidentInvestigateCommand(incidentRest, deps);
      } finally {
        await close();
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
