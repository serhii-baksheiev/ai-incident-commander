import {
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
import { Annotation, Command, END, START, StateGraph } from '@langchain/langgraph';

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
  | Readonly<{ route: 'challenge-required'; stopKind?: never }>
  | Readonly<{ route: 'terminal'; stopKind: InvestigationStop }>;

export const MAX_CHALLENGE_ROUNDS = 2 as const;

export interface ChallengeResult {
  readonly alternative: Hypothesis;
  readonly discriminatingTests: readonly InvestigationTest[];
}

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

function controlWithoutStopKind(
  control: IncidentStateControl,
): IncidentStateControl {
  const { stopKind: _stopKind, ...rest } = control;
  return rest;
}

function preserveGraphOwnedControl(node: InvestigationNode): InvestigationNode {
  return async (state) => {
    const update = await node(state);
    if (update.control === undefined) return update;

    const {
      stopKind: _ignoredStopKind,
      challengeRounds: _ignoredChallengeRounds,
      reservedChallengeBudget: _ignoredReservedChallengeBudget,
      ...control
    } = update.control;
    const protectedControl = {
      ...control,
      challengeRounds: state.control.challengeRounds,
      reservedChallengeBudget: state.control.reservedChallengeBudget,
    };

    return {
      ...update,
      control:
        state.control.stopKind === undefined
          ? protectedControl
          : { ...protectedControl, stopKind: state.control.stopKind },
    };
  };
}

export function createInvestigationGraph({
  nodes,
}: Readonly<{ nodes: InvestigationNodes }>) {
  const terminate = (
    state: typeof InvestigationStateAnnotation.State,
    stopKind: InvestigationStop,
  ) =>
    new Command({
      goto: 'propose_conclusion',
      update: {
        control: { ...state.control, stopKind },
      },
    });

  const routeChallenge = (state: typeof InvestigationStateAnnotation.State) => {
    if (state.control.challengeRounds >= MAX_CHALLENGE_ROUNDS) {
      return terminate(state, 'ambiguous');
    }

    if (state.control.reservedChallengeBudget <= 0) {
      return terminate(state, 'budget-exhausted');
    }

    return new Command({
      goto: 'challenge_hypothesis',
      update: { control: controlWithoutStopKind(state.control) },
    });
  };

  const terminationCheck = async (
    state: typeof InvestigationStateAnnotation.State,
  ) => {
    const decision = await nodes.termination_check(state);

    if (
      decision.route === 'terminal' &&
      decision.stopKind === 'sufficient' &&
      state.control.challengeRounds === 0
    ) {
      return routeChallenge(state);
    }

    if (decision.route === 'need-more-evidence') {
      return new Command({
        goto: 'plan_investigation',
        update: { control: controlWithoutStopKind(state.control) },
      });
    }

    if (decision.route === 'challenge-required') {
      return routeChallenge(state);
    }

    return terminate(state, decision.stopKind);
  };

  const challengeHypothesis: InvestigationNode = async (state) => {
    const result = await nodes.challenge_hypothesis(state);

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

  return new StateGraph(InvestigationStateAnnotation)
    .addNode(
      'normalize_incident',
      preserveGraphOwnedControl(nodes.normalize_incident),
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
    .addEdge('propose_conclusion', END)
    .compile();
}
