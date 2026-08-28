import {
  HypothesisSchema,
  InvestigationTestSchema,
  upsertById,
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
  isCommand,
} from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

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

export type ConclusionReviewDecision =
  | Readonly<{ action: 'confirm' }>
  | Readonly<{ action: 'reject' }>
  | Readonly<{ action: 'add_hypothesis'; hypothesis: Hypothesis }>;

export type InvestigationNode = (
  state: IncidentState,
) => Partial<IncidentState> | Promise<Partial<IncidentState>>;

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

function assertInterruptScopedResume(input: unknown): void {
  if (!isCommand(input) || input.resume === undefined) return;

  const resumeMap = input.resume;
  if (
    typeof resumeMap !== 'object' ||
    resumeMap === null ||
    Array.isArray(resumeMap) ||
    Object.keys(resumeMap).length === 0 ||
    Object.keys(resumeMap).some((id) => !/^[0-9a-f]{32}$/.test(id))
  ) {
    throw new Error('conclusion review resume must target its interrupt id');
  }
}

function preserveGraphOwnedControl(node: InvestigationNode): InvestigationNode {
  return async (state) => {
    const protectedControl = {
      stopKind: state.control.stopKind,
      challengeRounds: state.control.challengeRounds,
      reservedChallengeBudget: state.control.reservedChallengeBudget,
    };
    const update = await node(incidentStateOf(state as InvestigationGraphState));
    if (update.control === undefined) return update;

    const {
      stopKind: _ignoredStopKind,
      challengeRounds: _ignoredChallengeRounds,
      reservedChallengeBudget: _ignoredReservedChallengeBudget,
      ...control
    } = update.control;
    const controlUpdate = {
      ...control,
      challengeRounds: protectedControl.challengeRounds,
      reservedChallengeBudget: protectedControl.reservedChallengeBudget,
    };

    return {
      ...update,
      control:
        protectedControl.stopKind === undefined
          ? controlUpdate
          : { ...controlUpdate, stopKind: protectedControl.stopKind },
    };
  };
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

function parseConclusionReviewDecision(
  value: unknown,
): ConclusionReviewDecision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid conclusion review decision');
  }

  const record = value as Record<string, unknown>;
  if (
    (record.action === 'confirm' || record.action === 'reject') &&
    Object.keys(record).length === 1
  ) {
    return { action: record.action };
  }

  if (
    record.action === 'add_hypothesis' &&
    Object.keys(record).length === 2 &&
    Object.hasOwn(record, 'hypothesis')
  ) {
    const hypothesis = HypothesisSchema.safeParse(record.hypothesis);
    if (hypothesis.success && hypothesis.data.createdBy === 'initial') {
      return { action: record.action, hypothesis: hypothesis.data };
    }
  }

  throw new Error('invalid conclusion review decision');
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
    const decision = await nodes.termination_check(incidentStateOf(state));

    if (
      decision.route === 'terminal' &&
      decision.stopKind === 'sufficient' &&
      state.control.challengeRounds === 0
    ) {
      return routeChallenge(state, decision.leaderId);
    }

    if (decision.route === 'need-more-evidence') {
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
    const resumed = interrupt({
      kind: 'conclusion-review',
      runId: state.control.runId,
      conclusion: state.conclusion,
    });
    const decision = parseConclusionReviewDecision(resumed);

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

    if (state.hypotheses.some(({ id }) => id === decision.hypothesis.id)) {
      throw new Error('human-added hypothesis reuses an existing hypothesis id');
    }

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
      preserveGraphOwnedControl(nodes.plan_investigation),
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

  const invoke = graph.invoke.bind(graph);
  graph.invoke = (async (...args: Parameters<typeof graph.invoke>) => {
    assertInterruptScopedResume(args[0]);
    return invoke(...args);
  }) as typeof graph.invoke;

  return graph;
}
