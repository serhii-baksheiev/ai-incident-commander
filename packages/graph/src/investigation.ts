import {
  ConclusionReviewDecisionSchema,
  HypothesisSchema,
  IncidentStateSchema,
  InvestigationTestSchema,
  upsertById,
  type ConclusionReviewDecision,
  type Evidence,
  type EvidenceAssessment,
  type Hypothesis,
  type Incident,
  type IncidentConclusion,
  type IncidentState,
  type IncidentStateControl,
  type InvestigationStop,
  type InvestigationTest,
  type Prediction,
  type Trial,
} from '@aic/domain';
import {
  Annotation,
  Command,
  END,
  Send,
  START,
  StateGraph,
  getConfig,
  interrupt,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

export { ConclusionReviewDecisionSchema };
export type { ConclusionReviewDecision };

export const INVESTIGATION_NODE_NAMES = [
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
] as const;

export type InvestigationNodeName = (typeof INVESTIGATION_NODE_NAMES)[number];
export type InvestigationRoute =
  | 'need-more-evidence'
  | 'challenge-required'
  | 'terminal';

export type TerminationDecision =
  | Readonly<{ route: 'need-more-evidence'; stopKind?: never }>
  | Readonly<{
      route: 'challenge-required';
      leaderId: string;
      stopKind?: never;
    }>
  | Readonly<{
      route: 'terminal';
      stopKind: 'sufficient';
      leaderId: string;
    }>
  | Readonly<{
      route: 'terminal';
      stopKind: Exclude<InvestigationStop, 'sufficient'>;
      leaderId?: never;
    }>;

export const MAX_CHALLENGE_ROUNDS = 2 as const;

export interface ChallengeResult {
  readonly alternative: Hypothesis;
  readonly discriminatingTests: readonly InvestigationTest[];
}

export type InvestigationExecutionInput =
  | Readonly<{ kind: 'start'; state: IncidentState }>
  | Readonly<{
      kind: 'resume';
      interruptId: string;
      decision: ConclusionReviewDecision;
    }>;

export type InvestigationExecutionConfig = Readonly<{
  threadId: string;
}>;

/**
 * What a lifecycle node hands back to the graph.
 *
 * `declaredLlmCalls` is the ONE channel through which a node reports LLM
 * consumption, and it is a declaration rather than a write: the node says how
 * many calls it made, the graph validates that number and folds it into the
 * counter it owns. A node cannot reach `control.llmCallsUsed` itself — see
 * `preserveGraphOwnedControl`.
 *
 * Nothing in this repository declares anything today, because no LLM execution
 * path exists. That is why `llmCallsUsed` is observed to be exactly 0 rather
 * than estimated: an unused channel reports nothing, where a synthesised count
 * would be cost evidence nobody measured. The boundary is here so a real
 * provider, when one arrives, reports through it instead of inventing its own.
 *
 * ⚠ Limit, by construction: `termination_check` and `challenge_hypothesis`
 * return their own decision types and so have no channel of their own. Their
 * consumption is not declarable, and this is stated rather than hidden — see
 * `investigation-graph.test.mjs` › "adds a node-declared llm call count to
 * llmCallsUsed through the typed boundary" for what the channel does cover.
 */
export type InvestigationNodeResult = Partial<IncidentState> &
  Readonly<{ declaredLlmCalls?: number }>;

export type InvestigationNode = (
  state: IncidentState,
) => InvestigationNodeResult | Promise<InvestigationNodeResult>;

export type InvestigationNodes = Omit<
  Record<InvestigationNodeName, InvestigationNode>,
  'termination_check' | 'challenge_hypothesis'
> &
  Readonly<{
    termination_check(
      state: IncidentState,
    ): TerminationDecision | Promise<TerminationDecision>;
    challenge_hypothesis(
      state: IncidentState,
      leaderId: string,
    ): ChallengeResult | Promise<ChallengeResult>;
  }>;

const InvestigationStateAnnotation = Annotation.Root({
  incident: Annotation<Incident>(),
  hypotheses: Annotation<Hypothesis[], Hypothesis | readonly Hypothesis[]>({
    reducer: (current, update) => upsertById(current, update),
    default: () => [],
  }),
  predictions: Annotation<Prediction[], Prediction | readonly Prediction[]>({
    reducer: (current, update) => upsertById(current, update),
    default: () => [],
  }),
  tests: Annotation<
    InvestigationTest[],
    InvestigationTest | readonly InvestigationTest[]
  >({
    reducer: (current, update) => upsertById(current, update),
    default: () => [],
  }),
  trials: Annotation<Trial[], Trial | readonly Trial[]>({
    reducer: (current, update) => upsertById(current, update),
    default: () => [],
  }),
  evidence: Annotation<Evidence[], Evidence | readonly Evidence[]>({
    reducer: (current, update) => upsertById(current, update),
    default: () => [],
  }),
  assessments: Annotation<
    EvidenceAssessment[],
    EvidenceAssessment | readonly EvidenceAssessment[]
  >({
    reducer: (current, update) => upsertById(current, update),
    default: () => [],
  }),
  conclusion: Annotation<IncidentConclusion | undefined>(),
  control: Annotation<IncidentStateControl>(),
});

type InvestigationGraphState = typeof InvestigationStateAnnotation.State;

function incidentStateOf(state: InvestigationGraphState): IncidentState {
  return {
    incident: state.incident,
    hypotheses: state.hypotheses,
    predictions: state.predictions,
    tests: state.tests,
    trials: state.trials,
    evidence: state.evidence,
    assessments: state.assessments,
    conclusion: state.conclusion,
    control: { ...state.control },
  };
}

function controlWithoutStopKind(
  control: IncidentStateControl,
): IncidentStateControl {
  const { stopKind: _stopKind, ...rest } = control;
  return rest;
}

function assertInteractiveRunIdentity(state: InvestigationGraphState): void {
  if (!state.control.humanReview) return;

  const threadId = getConfig().configurable?.thread_id;
  if (threadId !== state.control.runId) {
    throw new Error('interactive runId must match LangGraph thread_id');
  }
}

function readExactOwnDataProperties(
  record: object,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.length !== expectedKeys.length) return undefined;

  const entries: [string, unknown][] = [];
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      return undefined;
    }
    entries.push([key, descriptor.value]);
  }
  return Object.fromEntries(entries);
}

function parseInvestigationExecutionInput(
  input: unknown,
): InvestigationExecutionInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('invalid investigation execution input');
  }

  const start = readExactOwnDataProperties(input, ['kind', 'state']);
  if (start?.kind === 'start') {
    const state = IncidentStateSchema.safeParse(start.state);
    if (state.success) return { kind: 'start', state: state.data };
  }

  const resume = readExactOwnDataProperties(input, [
    'kind',
    'interruptId',
    'decision',
  ]);
  if (
    resume?.kind === 'resume' &&
    typeof resume.interruptId === 'string' &&
    /^[0-9a-f]{32}$/.test(resume.interruptId)
  ) {
    const decision = ConclusionReviewDecisionSchema.safeParse(resume.decision);
    if (decision.success) {
      return {
        kind: 'resume',
        interruptId: resume.interruptId,
        decision: decision.data,
      };
    }
  }

  throw new Error('invalid investigation execution input');
}

function parseInvestigationExecutionConfig(
  config: unknown,
): InvestigationExecutionConfig | undefined {
  if (config === undefined) return undefined;
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('invalid investigation execution config');
  }

  const record = readExactOwnDataProperties(config, ['threadId']);
  if (
    typeof record?.threadId !== 'string' ||
    record.threadId.length === 0
  ) {
    throw new Error('invalid investigation execution config');
  }

  return { threadId: record.threadId };
}

function langGraphConfigOf(
  config: InvestigationExecutionConfig | undefined,
): LangGraphRunnableConfig | undefined {
  return config === undefined
    ? undefined
    : { configurable: { thread_id: config.threadId } };
}

function assertHumanHypothesisIdIsAvailable(
  state: Pick<InvestigationGraphState, 'hypotheses'>,
  decision: ConclusionReviewDecision,
): void {
  if (
    decision.action === 'add_hypothesis' &&
    state.hypotheses.some(({ id }) => id === decision.hypothesis.id)
  ) {
    throw new Error('human-added hypothesis reuses an existing hypothesis id');
  }
}

/**
 * Reads a node's LLM declaration, and refuses anything that is not a count.
 *
 * Absent is the ordinary case and means zero — no node in this repository
 * declares anything. Present-but-not-a-count is a different case and throws:
 * the node tried to report consumption and got the shape wrong, and folding
 * that into a graph-owned counter would corrupt the one number the budget is
 * decided from.
 */
function readDeclaredLlmCalls(result: InvestigationNodeResult): number {
  const declared = result.declaredLlmCalls;
  if (declared === undefined) return 0;

  if (typeof declared !== 'number' || !Number.isSafeInteger(declared) || declared < 0) {
    throw new Error('invalid declared llm call count');
  }

  return declared;
}

/**
 * Wraps a lifecycle node so the graph keeps ownership of every control field a
 * node must not decide: the stop kind, the challenge counters, and — since
 * AIC-62 — the two logical budgets and their usage counters.
 *
 * `countsLogicalIteration` is what makes `iterationsUsed` graph-owned rather
 * than node-reported: the increment happens HERE, on entry to the wrapped node,
 * so a node cannot fail to count its own iteration or count it twice.
 */
function preserveGraphOwnedControl(
  node: InvestigationNode,
  options: Readonly<{ countsLogicalIteration?: boolean }> = {},
): InvestigationNode {
  return async (state) => {
    const current = (state as InvestigationGraphState).control;
    assertLogicalBudgetCounters(current);

    const protectedControl = {
      stopKind: current.stopKind,
      challengeRounds: current.challengeRounds,
      reservedChallengeBudget: current.reservedChallengeBudget,
      maxIterations: current.maxIterations,
      llmCallBudget: current.llmCallBudget,
      iterationsUsed:
        current.iterationsUsed + (options.countsLogicalIteration ? 1 : 0),
      llmCallsUsed: current.llmCallsUsed,
    };
    const result = await node(incidentStateOf(state as InvestigationGraphState));
    const { declaredLlmCalls: _ignoredDeclaredLlmCalls, ...update } = result;
    const graphOwned = {
      challengeRounds: protectedControl.challengeRounds,
      reservedChallengeBudget: protectedControl.reservedChallengeBudget,
      maxIterations: protectedControl.maxIterations,
      llmCallBudget: protectedControl.llmCallBudget,
      iterationsUsed: protectedControl.iterationsUsed,
      llmCallsUsed: protectedControl.llmCallsUsed + readDeclaredLlmCalls(result),
    };

    // The node's own control update is the base only when it sent one; with no
    // update the current control is, so a graph-owned increment still lands.
    const {
      stopKind: _ignoredStopKind,
      challengeRounds: _ignoredChallengeRounds,
      reservedChallengeBudget: _ignoredReservedChallengeBudget,
      maxIterations: _ignoredMaxIterations,
      llmCallBudget: _ignoredLlmCallBudget,
      iterationsUsed: _ignoredIterationsUsed,
      llmCallsUsed: _ignoredLlmCallsUsed,
      ...control
    } = update.control ?? current;
    const controlUpdate = { ...control, ...graphOwned };

    return {
      ...update,
      control:
        protectedControl.stopKind === undefined
          ? controlUpdate
          : { ...controlUpdate, stopKind: protectedControl.stopKind },
    };
  };
}

/**
 * Fails closed on a logical budget or usage counter that is not a count.
 *
 * Runs before any budget is spent, and before a node runs, because the whole
 * point of a budget is that the number it is decided from is trustworthy: a
 * fractional or negative counter silently changes what "exhausted" means, and a
 * run that continued on one would report usage nobody can reconcile.
 */
function assertLogicalBudgetCounters(control: IncidentStateControl): void {
  for (const [field, value] of [
    ['iteration budget', control.maxIterations],
    ['llm call budget', control.llmCallBudget],
    ['logical iteration counter', control.iterationsUsed],
    ['llm call counter', control.llmCallsUsed],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`invalid ${field}`);
    }
  }
}

function assertChallengeCounters(control: IncidentStateControl): void {
  if (
    !Number.isSafeInteger(control.challengeRounds) ||
    control.challengeRounds < 0 ||
    control.challengeRounds > MAX_CHALLENGE_ROUNDS
  ) {
    throw new Error('invalid challenge round counter');
  }

  if (
    !Number.isSafeInteger(control.reservedChallengeBudget) ||
    control.reservedChallengeBudget < 0
  ) {
    throw new Error('invalid reserved challenge budget');
  }
}

function parseChallengeResult(
  value: unknown,
  state: InvestigationGraphState,
): ChallengeResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid challenge result');
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, 'alternative') ||
    !Object.hasOwn(record, 'discriminatingTests') ||
    !Array.isArray(record.discriminatingTests) ||
    record.discriminatingTests.length === 0
  ) {
    throw new Error('invalid challenge result');
  }

  const alternativeResult = HypothesisSchema.safeParse(record.alternative);
  const testsResult = record.discriminatingTests.map((test) =>
    InvestigationTestSchema.safeParse(test),
  );
  if (
    !alternativeResult.success ||
    alternativeResult.data.createdBy !== 'challenge' ||
    testsResult.some((result) => !result.success)
  ) {
    throw new Error('invalid challenge result');
  }

  const alternative = alternativeResult.data;
  if (state.hypotheses.some(({ id }) => id === alternative.id)) {
    throw new Error('challenge result reuses an existing hypothesis id');
  }

  const seenTestIds = new Set(state.tests.map(({ id }) => id));
  const discriminatingTests = testsResult.map((result) => {
    if (!result.success) throw new Error('invalid challenge result');
    if (seenTestIds.has(result.data.id)) {
      throw new Error('challenge result reuses an investigation test id');
    }
    seenTestIds.add(result.data.id);
    return result.data;
  });

  return { alternative, discriminatingTests };
}

export function createInvestigationGraph({
  nodes,
  checkpointer,
}: Readonly<{
  nodes: InvestigationNodes;
  checkpointer?: BaseCheckpointSaver;
}>) {
  const terminate = (
    state: InvestigationGraphState,
    stopKind: InvestigationStop,
  ) =>
    new Command({
      goto: 'propose_conclusion',
      update: {
        control: { ...state.control, stopKind },
      },
    });

  const routeChallenge = (
    state: InvestigationGraphState,
    leaderId: string | undefined,
  ) => {
    assertChallengeCounters(state.control);

    if (state.control.challengeRounds >= MAX_CHALLENGE_ROUNDS) {
      return terminate(state, 'ambiguous');
    }

    if (state.control.reservedChallengeBudget <= 0) {
      return terminate(state, 'budget-exhausted');
    }

    if (
      leaderId === undefined ||
      !state.hypotheses.some(({ id }) => id === leaderId)
    ) {
      throw new Error('challenge target is not a current hypothesis');
    }

    return new Command({
      goto: new Send('challenge_hypothesis', {
        ...incidentStateOf(state),
        challengeTargetId: leaderId,
      }),
      update: { control: controlWithoutStopKind(state.control) },
    });
  };

  const terminationCheck = async (
    state: InvestigationGraphState,
  ) => {
    assertChallengeCounters(state.control);
    assertLogicalBudgetCounters(state.control);

    const decision = await nodes.termination_check(incidentStateOf(state));

    if (
      decision.route === 'terminal' &&
      decision.stopKind === 'sufficient' &&
      state.control.challengeRounds === 0
    ) {
      return routeChallenge(state, decision.leaderId);
    }

    if (decision.route === 'need-more-evidence') {
      // A logical budget bounds what the graph may still SPEND, so it is read
      // on the continue path and not against a decision that has already
      // concluded: a run that reached a terminal stop kind keeps it, rather
      // than having an exhausted budget overwrite the finding.
      //
      // `budget-exhausted` is the existing stop kind for a spent budget — the
      // reserved challenge reserve already terminates through it — so an
      // exhausted logical budget reads the same way rather than inventing one.
      // Like that reserve, the check runs after `termination_check` has been
      // consulted, which keeps this node the sole owner of the stop kind and
      // keeps one trace shape across all three budgets.
      if (
        state.control.iterationsUsed >= state.control.maxIterations ||
        state.control.llmCallsUsed >= state.control.llmCallBudget
      ) {
        return terminate(state, 'budget-exhausted');
      }

      return new Command({
        goto: 'plan_investigation',
        update: { control: controlWithoutStopKind(state.control) },
      });
    }

    if (decision.route === 'challenge-required') {
      return routeChallenge(state, decision.leaderId);
    }

    return terminate(state, decision.stopKind);
  };

  const challengeHypothesis = async (state: InvestigationGraphState) => {
    assertChallengeCounters(state.control);
    const leaderId = (state as InvestigationGraphState & {
      readonly challengeTargetId?: string;
    }).challengeTargetId;
    if (
      leaderId === undefined ||
      !state.hypotheses.some(({ id }) => id === leaderId)
    ) {
      throw new Error('challenge target is not a current hypothesis');
    }
    const result = parseChallengeResult(
      await nodes.challenge_hypothesis(incidentStateOf(state), leaderId),
      state,
    );

    return {
      hypotheses: [result.alternative],
      tests: [...result.discriminatingTests],
      control: {
        ...controlWithoutStopKind(state.control),
        challengeRounds: state.control.challengeRounds + 1,
        reservedChallengeBudget: state.control.reservedChallengeBudget - 1,
      },
    };
  };

  const reviewConclusion = (state: InvestigationGraphState) => {
    assertInteractiveRunIdentity(state);
    const decision = ConclusionReviewDecisionSchema.parse(
      interrupt({
        kind: 'conclusion-review',
        runId: state.control.runId,
        conclusion: state.conclusion,
      }),
    );

    if (decision.action === 'confirm') {
      return new Command({ goto: END });
    }

    const control = controlWithoutStopKind(state.control);
    if (decision.action === 'reject') {
      return new Command({
        goto: 'generate_hypotheses',
        update: { control },
      });
    }

    assertHumanHypothesisIdIsAvailable(state, decision);

    return new Command({
      goto: 'derive_predictions',
      update: {
        hypotheses: [decision.hypothesis],
        control,
      },
    });
  };

  const normalizeIncident = preserveGraphOwnedControl(
    nodes.normalize_incident,
  );

  const graph = new StateGraph(InvestigationStateAnnotation)
    .addNode(
      'normalize_incident',
      async (state) => {
        assertInteractiveRunIdentity(state);
        return normalizeIncident(state);
      },
    )
    .addNode(
      'collect_baseline',
      preserveGraphOwnedControl(nodes.collect_baseline),
    )
    .addNode(
      'generate_hypotheses',
      preserveGraphOwnedControl(nodes.generate_hypotheses),
    )
    .addNode(
      'derive_predictions',
      preserveGraphOwnedControl(nodes.derive_predictions),
    )
    .addNode(
      'plan_investigation',
      // Entering this node IS a logical investigation iteration — it is the
      // node the loop-back edge returns to, so counting here counts exactly the
      // iterations `maxIterations` is meant to bound.
      preserveGraphOwnedControl(nodes.plan_investigation, {
        countsLogicalIteration: true,
      }),
    )
    .addNode(
      'execute_investigation',
      preserveGraphOwnedControl(nodes.execute_investigation),
    )
    .addNode(
      'evaluate_predictions',
      preserveGraphOwnedControl(nodes.evaluate_predictions),
    )
    .addNode(
      'interpret_residual_evidence',
      preserveGraphOwnedControl(nodes.interpret_residual_evidence),
    )
    .addNode(
      'derive_hypothesis_state',
      preserveGraphOwnedControl(nodes.derive_hypothesis_state),
    )
    .addNode('termination_check', terminationCheck, {
      ends: [
        'plan_investigation',
        'challenge_hypothesis',
        'propose_conclusion',
      ],
    })
    .addNode(
      'challenge_hypothesis',
      challengeHypothesis,
    )
    .addNode(
      'propose_conclusion',
      preserveGraphOwnedControl(nodes.propose_conclusion),
    )
    .addNode('review_conclusion', reviewConclusion, {
      ends: [END, 'generate_hypotheses', 'derive_predictions'],
    })
    .addEdge(START, 'normalize_incident')
    .addEdge('normalize_incident', 'collect_baseline')
    .addEdge('collect_baseline', 'generate_hypotheses')
    .addEdge('generate_hypotheses', 'derive_predictions')
    .addEdge('derive_predictions', 'plan_investigation')
    .addEdge('plan_investigation', 'execute_investigation')
    .addEdge('execute_investigation', 'evaluate_predictions')
    .addEdge('evaluate_predictions', 'interpret_residual_evidence')
    .addEdge('interpret_residual_evidence', 'derive_hypothesis_state')
    .addEdge('derive_hypothesis_state', 'termination_check')
    .addEdge('challenge_hypothesis', 'execute_investigation')
    .addConditionalEdges(
      'propose_conclusion',
      (state) => (state.control.humanReview ? 'review_conclusion' : END),
      ['review_conclusion', END],
    )
    .compile({ checkpointer });

  return Object.freeze({
    async execute(
      input: InvestigationExecutionInput,
      config?: InvestigationExecutionConfig,
    ) {
      const request = parseInvestigationExecutionInput(input);
      const executionConfig = parseInvestigationExecutionConfig(config);
      if (
        request.kind === 'start' &&
        request.state.control.humanReview &&
        executionConfig?.threadId !== request.state.control.runId
      ) {
        throw new Error('interactive runId must match execution threadId');
      }
      if (request.kind === 'resume' && executionConfig === undefined) {
        throw new Error('interactive resume requires an execution threadId');
      }
      const langGraphConfig = langGraphConfigOf(executionConfig);
      if (
        request.kind === 'resume' &&
        request.decision.action === 'add_hypothesis' &&
        langGraphConfig !== undefined
      ) {
        const snapshot = await graph.getState(langGraphConfig);
        const targetsPendingInterrupt = snapshot.tasks.some(({ interrupts }) =>
          interrupts.some(({ id }) => id === request.interruptId),
        );
        if (targetsPendingInterrupt) {
          assertHumanHypothesisIdIsAvailable(
            snapshot.values,
            request.decision,
          );
        }
      }
      const graphInput =
        request.kind === 'start'
          ? request.state
          : new Command({
              resume: {
                [request.interruptId]: request.decision,
              },
            });
      return graph.invoke(
        graphInput as Parameters<typeof graph.invoke>[0],
        langGraphConfig,
      );
    },
    async getGraph() {
      const topology = await graph.getGraph();
      const nodes = Object.fromEntries(
        Object.keys(topology.nodes).map((id) => [id, Object.freeze({ id })]),
      );
      const edges = topology.edges.map(({ source, target, conditional }) =>
        Object.freeze({
          source,
          target,
          conditional: Boolean(conditional),
        }),
      );

      return Object.freeze({
        nodes: Object.freeze(nodes),
        edges: Object.freeze(edges),
      });
    },
    async getState(config: InvestigationExecutionConfig) {
      const executionConfig = parseInvestigationExecutionConfig(config);
      if (executionConfig === undefined) {
        throw new Error('getState requires an execution threadId');
      }
      return graph.getState({
        configurable: { thread_id: executionConfig.threadId },
      });
    },
  });
}
