#!/usr/bin/env node

import { parseArgs } from 'node:util';

import { createRegistryStore, setupApplicationSchema, type RegistryStore } from '@aic/persistence';

import { runRegistryCommand, type RegistryCommandDeps } from './commands/registry.js';
import { runDevSpike } from './commands/dev-spike.js';
import { runInvestigate } from './commands/investigate.js';

// The onboarding nouns docs/decisions/integration-boundary.md's Terminology
// section fixes for AIC-99, still stubs in this slice.
const STUB_NOUNS = ['incident', 'doctor', 'apply'] as const;
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
  incident     Start an Incident investigation
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
 * see cli-dispatcher.test.mjs › "the noun with no subcommand ... names
 * 'subcommand' as the problem" (spawned with no AIC_POSTGRES_URL at all)
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
      throw new Error(`unknown command: dev ${sub ?? ''}`.trim());
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
    const connectionString = requirePostgresUrl(process.env);
    const deps: RegistryCommandDeps = {
      stdout: writeStdoutLine,
      setupApplicationSchema,
      connectionString,
    };
    await runRegistryCommand('db', rest, deps);
    return;
  }

  if (isRegistryNoun(command)) {
    // `source check` remains the "not implemented" stub in this slice; only
    // `source add` (and the other registry nouns' own subcommands) are real.
    if (command === 'source') {
      const { command: sourceSub } = nextPositional(rest);
      if (sourceSub === 'check') {
        runOnboardingStub('source');
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

  throw new Error(`unknown command: ${command}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`aic: ${message}\n`);
  process.exitCode = 1;
});
