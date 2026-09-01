#!/usr/bin/env node

import {
  createPersistentInvestigationRunner,
  type ExecuteInvestigationContext,
  type InvocationTrace,
} from '@aic/graph';
import { resolveTracingConfig } from '@aic/observability';
import { createSqliteCheckpointer } from '@aic/persistence';

const generalHelp = `AI Incident Commander

Usage: aic <command> [options]

Commands:
  start    Start and checkpoint a persistent investigation spike
  resume   Resume a checkpointed run by its run id

Run "aic <command> --help" for command options.`;

function commandHelp(command: 'start' | 'resume'): string {
  return `Usage: aic ${command} --run-id <id> --checkpoint <sqlite-file>

Options:
  --run-id       Run identity and LangGraph thread_id
  --checkpoint   SQLite checkpoint file
  --help         Show this help`;
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function payloadFingerprint(context: ExecuteInvestigationContext): string {
  return JSON.stringify({
    runId: context.runId,
    testId: context.testId,
    attempt: context.attempt,
    tool: context.tool,
    input: context.input,
  });
}

async function run(command: 'start' | 'resume', args: readonly string[]): Promise<void> {
  const runId = option(args, '--run-id');
  const checkpointPath = option(args, '--checkpoint');
  // Resolved before any work starts: tracing that was asked for and cannot be
  // delivered must stop the run, not degrade it into an untraced one.
  const tracing = resolveTracingConfig(process.env);
  if (tracing.enabled) {
    // This process exits as soon as it has printed its result. The tracer's
    // default is to send in the background, which drops whatever has not left
    // by then; `false` makes @langchain/core build its client with
    // `blockOnRootRunFinalization` (see its singletons/tracer.js). An operator
    // who set this deliberately keeps their value.
    process.env.LANGCHAIN_CALLBACKS_BACKGROUND ??= 'false';
  }
  const trace: InvocationTrace | undefined = tracing.enabled
    ? {
        runName: `aic-${command}`,
        tags: ['aic', `aic-${command}`],
        metadata: { command, project: tracing.project, checkpointed: true },
      }
    : undefined;
  const runner = createPersistentInvestigationRunner({
    checkpointer: createSqliteCheckpointer(checkpointPath),
    trace,
    async executeInvestigation(context) {
      const input = context.input as { observedAt?: unknown };
      const observedAt =
        typeof input?.observedAt === 'string'
          ? input.observedAt
          : '1970-01-01T00:00:00.000Z';
      return {
        trial: {
          status: 'ok',
          durationMs: 0,
        },
        evidence: {
          kind: 'config',
          source: 'persistence-spike',
          observedAt,
          statement: 'The deterministic persistence spike completed.',
          rawRef: `checkpoint://${context.runId}/${context.testId}`,
          reliability: 'high',
        },
        payloadFingerprint: payloadFingerprint(context),
      };
    },
  });

  const result =
    command === 'start'
      ? await runner.start({
          runId,
          test: {
            id: 'persistence-spike',
            tool: 'persistence-spike',
            input: { observedAt: new Date().toISOString() },
          },
        })
      : await runner.resume({ runId });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main(args: readonly string[]): Promise<void> {
  const [command, ...commandArgs] = args;
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(`${generalHelp}\n`);
    return;
  }
  if (command !== 'start' && command !== 'resume') {
    throw new Error(`unknown command: ${command}`);
  }
  if (commandArgs.includes('--help') || commandArgs.includes('-h')) {
    process.stdout.write(`${commandHelp(command)}\n`);
    return;
  }
  await run(command, commandArgs);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`aic: ${message}\n`);
  process.exitCode = 1;
});
