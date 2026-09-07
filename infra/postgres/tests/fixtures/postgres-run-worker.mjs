/**
 * The child process the PostgreSQL live lane restarts.
 *
 * It exists because "restarting the AIC process preserves resumability" cannot
 * be shown from inside one process: a graph that resumes in the same process
 * could be reading anything it still holds in memory. A second `spawn` that
 * shares nothing but the connection string and the thread id is the only
 * arrangement where the checkpointer is provably what carried the state.
 *
 * Four modes, two flows:
 *
 *   interrupt <runId>              a graph run that pauses at the human review
 *   confirm   <runId> <interrupt>  a NEW process that resumes that same pause
 *
 *   start-hang <runId> <testId>    a persistent runner that never returns from
 *                                  executeInvestigation, so it can be SIGKILLed
 *   resume     <runId>             a NEW process that recovers the pending test
 *
 * The first flow is a clean stop and a clean restart; the second is a crash. A
 * checkpointer can pass one and fail the other, so both are driven.
 *
 * Like `test/fixtures/persistent-resume-worker.mjs`, this file does nothing on
 * import — everything is behind the `process.send` check at the bottom — so it
 * is inert to any test runner that picks it up as a file.
 */

const [, , mode, runId, argument] = process.argv;

/**
 * The lifecycle node names the graph declares, and a fixture body for each.
 *
 * Copied in shape from `test/hitl-conclusion-review.test.mjs`, where the same
 * arrangement pins the interrupt and resume contract on SQLite. It is copied
 * rather than imported because that list lives inside a test file: the point of
 * this lane is to change the SUBSTRATE and nothing else, so the graph it drives
 * has to be the one the existing contract already describes.
 */
const lifecycleNodes = [
  'normalize_incident',
  'collect_baseline',
  'generate_hypotheses',
  'derive_predictions',
  'plan_investigation',
  'execute_investigation',
  'evaluate_predictions',
  'interpret_residual_evidence',
  'derive_hypothesis_state',
  'termination_check',
  'challenge_hypothesis',
  'propose_conclusion',
];

const proposedConclusion = { kind: 'inconclusive', causes: [] };

function reviewNodes() {
  return Object.fromEntries(
    lifecycleNodes.map((name) => [
      name,
      async () => {
        if (name === 'termination_check') {
          return { route: 'terminal', stopKind: 'stalled' };
        }
        if (name === 'challenge_hypothesis') {
          throw new Error('challenge must not run in this stalled-review fixture');
        }
        if (name === 'propose_conclusion') {
          return { conclusion: proposedConclusion };
        }
        return {};
      },
    ]),
  );
}

function initialState(INCIDENT_STATE_SCHEMA_VERSION, STATUS_RULES_VERSION) {
  return {
    incident: { id: 'incident-postgres-substrate' },
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: {
      runId,
      schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
      statusRulesVersion: STATUS_RULES_VERSION,
      phase: 'concluding',
      maxIterations: 4,
      llmCallBudget: 8,
      iterationsUsed: 0,
      llmCallsUsed: 0,
      resumeCount: 0,
      reservedChallengeBudget: 2,
      challengeRounds: 0,
      humanReview: true,
    },
  };
}

async function connectionString() {
  const value = process.env.AIC_POSTGRES_URL;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      'AIC_POSTGRES_URL is not set in this child process: the parent must pass it through childEnv({ AIC_POSTGRES_URL }), because the allow-list forwards nothing it is not told to',
    );
  }
  return value;
}

/** The interrupt/resume flow, driven through the investigation graph itself. */
async function runReviewFlow() {
  const { INCIDENT_STATE_SCHEMA_VERSION, STATUS_RULES_VERSION } = await import('@aic/domain');
  const { createInvestigationGraph } = await import('@aic/graph');
  const { createPostgresCheckpointer } = await import('@aic/persistence');
  const { INTERRUPT, isInterrupted } = await import('@langchain/langgraph');

  const checkpointer = await createPostgresCheckpointer(await connectionString());
  const execution = createInvestigationGraph({
    nodes: reviewNodes(),
    checkpointer,
  });
  const config = { threadId: runId };

  if (mode === 'interrupt') {
    const interrupted = await execution.execute(
      { kind: 'start', state: initialState(INCIDENT_STATE_SCHEMA_VERSION, STATUS_RULES_VERSION) },
      config,
    );
    if (!isInterrupted(interrupted)) {
      throw new Error('the interactive conclusion resolved instead of pausing for review');
    }
    const [current] = interrupted[INTERRUPT];
    const persisted = await execution.getState(config);
    process.send(
      {
        type: 'interrupted',
        interruptId: current.id,
        next: persisted.next,
        threadId: persisted.config?.configurable?.thread_id,
      },
      () => process.exit(0),
    );
    return;
  }

  // `confirm`: nothing from the first process is in scope here except the two
  // strings on the command line, so whatever this reads back came out of
  // PostgreSQL.
  const restored = await execution.getState(config);
  process.send({
    type: 'restored',
    next: restored.next,
    conclusion: restored.values?.conclusion,
    runIdInState: restored.values?.control?.runId,
    humanReview: restored.values?.control?.humanReview,
    pendingInterruptIds: (restored.tasks ?? []).flatMap((task) =>
      (task.interrupts ?? []).map((pending) => pending.id),
    ),
  });

  const completed = await execution.execute(
    { kind: 'resume', interruptId: argument, decision: { action: 'confirm' } },
    config,
  );
  const afterResume = await execution.getState(config);
  process.send(
    {
      type: 'completed',
      interrupted: isInterrupted(completed),
      conclusion: completed.conclusion,
      runIdInState: completed.control?.runId,
      next: afterResume.next,
      threadId: afterResume.config?.configurable?.thread_id,
    },
    () => process.exit(0),
  );
}

/** The crash/recover flow, driven through the persistent investigation runner. */
async function runPersistentFlow() {
  const { createPersistentInvestigationRunner } = await import('@aic/graph');
  const { createPostgresCheckpointer } = await import('@aic/persistence');

  const checkpointer = await createPostgresCheckpointer(await connectionString());
  const testId = argument ?? 'test-checkout';
  const runner = createPersistentInvestigationRunner({
    checkpointer,
    async executeInvestigation(context) {
      process.send({
        type: 'inside-execute-investigation',
        runId: context.runId,
        testId: context.testId,
        attempt: context.attempt,
      });

      if (mode === 'start-hang') {
        // Held open on purpose, for the reason
        // `test/fixtures/persistent-resume-worker.mjs` states in full: without
        // the ref this child exits on its own and the test's kill races an exit
        // it usually wins, which is a flake rather than a proof (AIC-68).
        // see test/persistent-resume.test.mjs ›
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
    mode === 'start-hang'
      ? await runner.start({
          runId,
          test: { id: testId, tool: 'fixture-tool', input: { service: 'checkout' } },
        })
      : await runner.resume({ runId });

  process.send({ type: 'completed', result }, () => process.exit(0));
}

async function main() {
  if (mode === 'interrupt' || mode === 'confirm') return runReviewFlow();
  if (mode === 'start-hang' || mode === 'resume') return runPersistentFlow();
  throw new Error(`unknown worker mode: ${mode}`);
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
