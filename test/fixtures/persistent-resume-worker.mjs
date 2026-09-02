const [, , mode, checkpointPath, runId, testId = 'test-checkout'] = process.argv;

async function main() {
  const { createPersistentInvestigationRunner } = await import('@aic/graph');
  const { createSqliteCheckpointer } = await import('@aic/persistence');

  const checkpointer = await createSqliteCheckpointer(checkpointPath);
  const runner = createPersistentInvestigationRunner({
    checkpointer,
    async executeInvestigation(context) {
      process.send({
        type: 'inside-execute-investigation',
        runId: context.runId,
        testId: context.testId,
        attempt: context.attempt,
      });

      if (mode === 'start') {
        // The test kills this process, and it must not beat the test to it. A
        // never-resolving await holds no libuv handle, and Node leaves the IPC
        // channel unref'd until something listens on it — so without this ref
        // the child exited on its own before the kill could land, and the kill
        // was racing an exit it usually, but not always, won: on the losing
        // side the parent signalled a zombie and waitpid reported the original
        // exit status, no signal (AIC-68).
        //
        // The ref holds only while the parent keeps the channel open, which is
        // what the test does for its whole duration. It is not a claim that
        // this process cannot exit at all: with the channel as its one live
        // handle, closing it ends the process with no signal.
        // see persistent-resume.test.mjs ›
        // "the start-mode worker stays alive until it is killed, so the kill is what ends it"
        process.channel.ref();
        await new Promise(() => {});
      }

      return {
        trial: {
          tool: 'spoofed-executor-tool',
          input: { service: 'spoofed-by-executor' },
          status: 'ok',
          durationMs: 1,
        },
        evidence: {
          kind: 'log',
          source: 'fixture-tool',
          observedAt: '2026-08-27T12:00:00.000Z',
          statement: 'checkout returned a deterministic fixture result',
          rawRef: 'fixture://checkout/result',
          reliability: 'high',
        },
        payloadFingerprint: 'fixture-payload-v1',
      };
    },
  });

  const result =
    mode === 'start'
      ? await runner.start({
          runId,
          test: {
            id: testId,
            tool: 'fixture-tool',
            input: { service: 'checkout' },
          },
        })
      : await runner.resume({ runId });

  process.send({ type: 'completed', result }, () => process.exit(0));
}

if (typeof process.send === 'function') {
  main().catch((error) => {
    process.send(
      {
        type: 'worker-error',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      () => process.exit(1),
    );
  });
}
