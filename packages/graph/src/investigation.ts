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

export type InvestigationNode = (
  state: IncidentState,
) => Partial<IncidentState> | Promise<Partial<IncidentState>>;

export type InvestigationNodes = Omit<
  Record<InvestigationNodeName, InvestigationNode>,
  'termination_check'
> &
  Readonly<{
    termination_check(
      state: IncidentState,
    ): TerminationDecision | Promise<TerminationDecision>;
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

function preserveTerminationDecision(node: InvestigationNode): InvestigationNode {
  return async (state) => {
    const update = await node(state);
    if (update.control === undefined) return update;

    const { stopKind: _ignored, ...control } = update.control;
    return {
      ...update,
      control:
        state.control.stopKind === undefined
          ? control
          : { ...control, stopKind: state.control.stopKind },
    };
  };
}

export function createInvestigationGraph({
  nodes,
}: Readonly<{ nodes: InvestigationNodes }>) {
  const terminationCheck = async (
    state: typeof InvestigationStateAnnotation.State,
  ) => {
    const decision = await nodes.termination_check(state);

    if (
      decision.route === 'terminal' &&
      decision.stopKind === 'sufficient' &&
      state.control.challengeRounds === 0
    ) {
      return new Command({
        goto: 'challenge_hypothesis',
        update: { control: controlWithoutStopKind(state.control) },
      });
    }

    if (decision.route === 'need-more-evidence') {
      return new Command({
        goto: 'plan_investigation',
        update: { control: controlWithoutStopKind(state.control) },
      });
    }

    if (decision.route === 'challenge-required') {
      return new Command({
        goto: 'challenge_hypothesis',
        update: { control: controlWithoutStopKind(state.control) },
      });
    }

    return new Command({
      goto: 'propose_conclusion',
      update: {
        control: { ...state.control, stopKind: decision.stopKind },
      },
    });
  };

  return new StateGraph(InvestigationStateAnnotation)
    .addNode(
      'normalize_incident',
      preserveTerminationDecision(nodes.normalize_incident),
    )
    .addNode(
      'collect_baseline',
      preserveTerminationDecision(nodes.collect_baseline),
    )
    .addNode(
      'generate_hypotheses',
      preserveTerminationDecision(nodes.generate_hypotheses),
    )
    .addNode(
      'derive_predictions',
      preserveTerminationDecision(nodes.derive_predictions),
    )
    .addNode(
      'plan_investigation',
      preserveTerminationDecision(nodes.plan_investigation),
    )
    .addNode(
      'execute_investigation',
      preserveTerminationDecision(nodes.execute_investigation),
    )
    .addNode(
      'evaluate_predictions',
      preserveTerminationDecision(nodes.evaluate_predictions),
    )
    .addNode(
      'interpret_residual_evidence',
      preserveTerminationDecision(nodes.interpret_residual_evidence),
    )
    .addNode(
      'derive_hypothesis_state',
      preserveTerminationDecision(nodes.derive_hypothesis_state),
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
      preserveTerminationDecision(nodes.challenge_hypothesis),
    )
    .addNode(
      'propose_conclusion',
      preserveTerminationDecision(nodes.propose_conclusion),
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
