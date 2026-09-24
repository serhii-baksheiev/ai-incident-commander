#!/usr/bin/env node

import { parseArgs } from 'node:util';

import { runDevSpike } from './commands/dev-spike.js';

// The onboarding nouns docs/decisions/integration-boundary.md's Terminology
// section fixes for AIC-99. Each is a stub in this slice; the subcommands
// under a noun are later slices' work.
const ONBOARDING_NOUNS = [
  'service',
  'env',
  'source',
  'policy',
  'incident',
  'doctor',
  'apply',
] as const;
type OnboardingNoun = (typeof ONBOARDING_NOUNS)[number];

const generalHelp = `AI Incident Commander

Usage: aic <command> [options]

Commands:
  service    Register and manage a Service AIC investigates
  env        Register and manage a Service's Environments
  source     Register and check evidence SourceBindings
  policy     Set the ActionPolicy for an Environment
  incident   Start an Incident investigation
  doctor     Check onboarding health
  apply      Apply a declarative onboarding manifest

Run "aic dev spike --help" for the development-only persistence spike.`;

function isOnboardingNoun(value: string): value is OnboardingNoun {
  return (ONBOARDING_NOUNS as readonly string[]).includes(value);
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

function runOnboardingStub(noun: OnboardingNoun): void {
  process.stderr.write(`aic: "${noun}" is not implemented in this build.\n`);
  process.exitCode = 1;
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

  if (command === 'start' || command === 'resume') {
    process.stderr.write(`aic: "${command}" moved to \`aic dev spike ${command}\`.\n`);
    process.exitCode = 1;
    return;
  }

  if (isOnboardingNoun(command)) {
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
