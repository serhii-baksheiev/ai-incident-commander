import {
  ConclusionReviewDecisionSchema,
  HypothesisSchema,
  INCIDENT_STATE_SCHEMA_VERSION,
  IncidentStateSchema,
  InvestigationTestSchema,
  LogicalCountSchema,
  STATUS_RULES_VERSION,
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
  isCommand,
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
 * The control fields the graph owns: a node may not decide any of them.
 *
 * This list is the one spelling of that set **in the code**.
 * `preserveGraphOwnedControl` derives its sites from it and
 * `InvestigationNodeResult` derives the compile-time prohibition from it.
 * Before AIC-73 that function spelled the names by hand three times: ten in
 * `protectedControl`, ten in the destructuring of the node's update, and nine
 * in `graphOwned`, which leaves `stopKind` out on purpose. The three agreed;
 * nothing made them, which is what this constant changes.
 *
 * A fourth copy, in prose, is why they were worth collapsing: the wrapper's
 * docstring used to name the set (written by AIC-62), went stale when AIC-63
 * added `resumeCount`, and AIC-65 deleted the sentence rather than repairing it.
 *
 * ⚠ Outside this file the set is described only in PART, and the drift that
 * predicts has already landed rather than being ahead of us:
 * `docs/incident-commander-architecture-v1.md` calls eight of these ten
 * graph-owned — the three budgets, the three usage counters, `runId` and
 * `humanReview` — and describes `challengeRounds` and `stopKind` as graph-owned
 * nowhere; `packages/domain/src/contracts.ts` annotates three
 * (`iterationsUsed`, `llmCallsUsed`, `resumeCount`) as per-field notes. Neither
 * is wrong about what it does say, neither is derived from this constant, and
 * neither is a place to audit the set from.
 *
 * **Frozen, and that is load-bearing rather than tidy.** `as const` is erased at
 * compile time, so an exported array is ordinary mutable runtime state that any
 * caller — a lifecycle node included, since a node is arbitrary in-process code
 * handed to `createInvestigationGraph` — can `import` and splice. Two entries
 * removed from it used to be enough to make `humanReview` and `runId` vanish
 * from persisted control, routing `propose_conclusion` straight to END with no
 * interrupt and no error: the exact bypass this set exists to prevent, reached
 * without writing either field. Under ESM's strict mode a frozen array throws
 * on every mutation form instead — pinned in
 * graph-owned-control-contract.test.mjs › "publishes the graph-owned control
 * field set as one exported constant".
 *
 * `satisfies` proves every entry is a real control field; it does NOT prove the
 * list is complete, so completeness is a test rather than a type — see
 * graph-owned-control-contract.test.mjs › "classifies every control field the
 * schema declares as graph-owned or node-writable", which partitions
 * `IncidentStateControlSchema` and goes red on a field classified neither way.
 */
export const GRAPH_OWNED_CONTROL_FIELDS = Object.freeze([
  'stopKind',
  'runId',
  'humanReview',
  'challengeRounds',
  'reservedChallengeBudget',
  'maxIterations',
  'llmCallBudget',
  'iterationsUsed',
  'llmCallsUsed',
  'resumeCount',
] as const satisfies readonly (keyof IncidentStateControl)[]);

export type GraphOwnedControlField =
  (typeof GRAPH_OWNED_CONTROL_FIELDS)[number];

/**
 * The control a lifecycle node may hand back — everything the graph does not
 * own, and nothing else.
 */
export type NodeWritableControl = Omit<
  IncidentStateControl,
  GraphOwnedControlField
>;

const GRAPH_OWNED_CONTROL_FIELD_SET: ReadonlySet<string> = new Set(
  GRAPH_OWNED_CONTROL_FIELDS,
);

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
 * path exists — no `declaredLlmCalls` is set anywhere in `packages/`. That is
 * why `llmCallsUsed` stays 0 by construction rather than by estimate: an unused
 * channel reports nothing, where a synthesised count would be cost evidence
 * nobody measured. The boundary is here so a real provider, when one arrives,
 * reports through it instead of inventing its own.
 *
 * ⚠ A second limit, and it is not the same one: consumption is folded in AFTER
 * the node ran, so a single declaration larger than the remaining budget is
 * recorded in full and caught at the next check. That is detection, not
 * pre-authorisation. Unreachable while nothing declares; it is what a provider
 * node has to fix.
 *
 * ⚠ Limit, by construction: `termination_check` and `challenge_hypothesis`
 * return their own decision types and so have no channel of their own. Their
 * consumption is not declarable, and this is stated rather than hidden — see
 * `investigation-graph.test.mjs` › "adds a node-declared llm call count to
 * llmCallsUsed through the typed boundary" for what the channel does cover.
 */
export type InvestigationNodeResult = Omit<Partial<IncidentState>, 'control'> &
  Readonly<{ control?: NodeWritableControl; declaredLlmCalls?: number }>;

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
  // An OWN data property only, the idiom `readExactOwnDataProperties` already
  // uses here. Reading `result.declaredLlmCalls` directly would walk the
  // prototype chain, and a polluted `Object.prototype.declaredLlmCalls` then
  // spends budget once per wrapped node with no node having declared anything.
  const descriptor = Object.getOwnPropertyDescriptor(result, 'declaredLlmCalls');
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return 0;

  const declared = descriptor.value;
  if (declared === undefined) return 0;

  if (!isLogicalCount(declared)) {
    throw new Error('invalid declared llm call count');
  }

  return declared;
}

/**
 * Is this value a routing instruction rather than a state update?
 *
 * `isCommand` is LangGraph's own predicate and catches the duck-typed
 * `{ lg_name: 'Command' }` shape as well as the class. `Send` is a second
 * routing type with no exported predicate, so it is matched by class.
 *
 * The array arm exists because an array carrying either one is a shape a raw
 * `StateGraph` honours, and `.some` stops at the first match. A NESTED array is
 * deliberately not walked: LangGraph refuses `[[command]]` outright, so there is
 * nothing there to swallow, and a recursive walk over caller data would be
 * unbounded work for a case that cannot arise.
 */
function isRoutingInstruction(value: unknown): boolean {
  if (isCommand(value) || value instanceof Send) return true;
  return (
    Array.isArray(value) &&
    value.some((entry) => isCommand(entry) || entry instanceof Send)
  );
}

/**
 * Writes an own data property, the way object-rest already does — never `[[Set]]`.
 *
 * Plain assignment consults the prototype chain for a setter, so a polluted
 * `Object.prototype.humanReview` would swallow the graph's own value on its way
 * into the object being built and leave the field absent. Both accumulators
 * below start as `{}` and are therefore exposed to exactly that, which is why
 * neither of them assigns — see graph-owned-control-contract.test.mjs ›
 * "keeps graph-owned control intact while Object.prototype carries a setter of
 * that name".
 */
function defineOwnValue(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Reads the graph-owned half of a control object, by the one list that names it.
 *
 * A field absent from the source lands as `undefined`, which is the shape
 * `stopKind` legitimately has on a run that has not stopped — the wrapper below
 * restores that field only when it carries a value.
 */
function pickGraphOwnedControl(
  control: IncidentStateControl,
): Pick<IncidentStateControl, GraphOwnedControlField> {
  const picked: Record<string, unknown> = {};
  for (const field of GRAPH_OWNED_CONTROL_FIELDS) {
    defineOwnValue(picked, field, control[field]);
  }
  return picked as Pick<IncidentStateControl, GraphOwnedControlField>;
}

/**
 * Drops every graph-owned field from a control object a node handed back.
 *
 * ⚠ Load-bearing for `stopKind` and for `stopKind` only. The `...graphOwned`
 * spread in the caller re-imposes the other nine whatever this function leaves
 * behind; `stopKind` is not in that spread, so a node's value survives unless
 * it is dropped here — pinned in graph-owned-control-contract.test.mjs ›
 * "hides a hijacked graph-owned field from every node that runs after it".
 *
 * `Object.keys` reads OWN enumerable keys only, the idiom the rest of this file
 * uses on caller data: a polluted `Object.prototype.llmCallsUsed` is not a key
 * of the node's update and so cannot arrive here as one. It also narrows what
 * the rest-spread this replaced would copy — a symbol-keyed own property on the
 * node's update no longer reaches the persisted control, which is a behaviour
 * change and so is pinned rather than asserted here:
 * graph-owned-control-contract.test.mjs › "drops a symbol-keyed property a
 * lifecycle node puts on its control update". Nothing in the domain schema is
 * symbol-keyed, and the direction is toward less caller data, not more.
 */
function withoutGraphOwnedControl(
  control: IncidentStateControl | NodeWritableControl,
): NodeWritableControl {
  const source = control as Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (GRAPH_OWNED_CONTROL_FIELD_SET.has(key)) continue;
    defineOwnValue(rest, key, source[key]);
  }
  return rest as NodeWritableControl;
}

/**
 * Wraps a lifecycle node so the graph keeps ownership of every control field a
 * node must not decide. Which fields those are is `GRAPH_OWNED_CONTROL_FIELDS`
 * and only that constant — this comment deliberately does not repeat the list,
 * because the copy that used to be here fell behind the code twice.
 *
 * Two of them are why the set matters rather than merely being tidy:
 * `humanReview` is what the `propose_conclusion` edge routes on and `runId` is
 * what the interactive identity check compares against the thread, so a node
 * writing either could route a conclusion past its human review — pinned in
 * hitl-conclusion-review.test.mjs › "does not let a lifecycle node disarm both
 * the review gate and the run identity at once".
 *
 * `countsLogicalIteration` is what makes `iterationsUsed` graph-owned rather
 * than node-reported: the increment happens HERE, on entry to the wrapped node,
 * so a node cannot fail to count its own iteration or count it twice.
 */
function preserveGraphOwnedControl(
  node: InvestigationNode,
  options: Readonly<{ countsLogicalIteration?: boolean }> = {},
): (state: IncidentState) => Promise<Partial<IncidentState>> {
  return async (state) => {
    const current = (state as InvestigationGraphState).control;
    assertPersistedStateVersion(current);
    assertLogicalBudgetCounters(current);
    // The third assertion earns its place on ONE input shape, and it is worth
    // naming precisely because AIC-76 removed the other one: a malformed count
    // now dies at the `kind: 'start'` boundary, so what still reaches here is a
    // well-formed `challengeRounds` above `MAX_CHALLENGE_ROUNDS` — a cap no
    // domain schema expresses, because the graph is what spends the rounds.
    // Without this call such a state runs nine lifecycle nodes before
    // `termination_check` refuses it. see investigation-graph.test.mjs ›
    // "refuses a round count past the cap on entry to the first node, not nine
    // nodes in"
    //
    // ⚠ Which of this graph's calls to `assertChallengeCounters` are actually
    // pinned, because the answer is not "all of them" and a reader would
    // otherwise assume it. Deleting one call at a time and running the suite:
    // `routeChallenge`, `terminationCheck` and `challengeHypothesis` redden
    // NOTHING — they are mutually masking, and were so before this call
    // existed. `reviewConclusion` and this call are the two that redden. That
    // is what a layered fail-closed graph looks like under mutation, not a
    // decayed guard: whichever layer you remove, the next one catches it. The
    // three unpinned calls are kept because each sits immediately before the
    // graph uses these counters for something — `routeChallenge` and
    // `terminationCheck` branch on them, `challengeHypothesis` increments and
    // decrements them, and asserting before incrementing garbage is as good a
    // reason as asserting before branching on it.
    //
    // This paragraph is itself a hand-written list, which is the shape AIC-67
    // warns about, and the trade is deliberate rather than overlooked: a grep
    // produces the call sites but cannot say which of them a test would catch,
    // and that is the whole content here. It goes stale on the next site added.
    assertChallengeCounters(current);

    const protectedControl = {
      ...pickGraphOwnedControl(current),
      iterationsUsed:
        current.iterationsUsed + (options.countsLogicalIteration ? 1 : 0),
    };
    const result = await node(incidentStateOf(state as InvestigationGraphState));

    // A `Command` is a routing instruction, and routing is the graph's. Spread
    // over one, the graph-owned control below would land on an object LangGraph
    // reads for its `goto` and its own `update` — so the ownership this wrapper
    // exists to enforce would be decided somewhere else.
    //
    // It already fails today, and that is exactly why the check is worth
    // adding: the failure is `input._updateAsTuples is not a function`, raised
    // by the dependency's internals after the wrapper has waved the value
    // through. Nothing local names that behaviour, so an upgrade could turn a
    // fail-closed into a bypass with every test still green. `isCommand` is
    // LangGraph's own predicate, which also catches the duck-typed
    // `{ lg_name: 'Command' }` shape a hand-built object could carry.
    //
    // Two more shapes are refused for the same reason, and the reason is NOT
    // that LangGraph would honour them here — it never sees them. The
    // destructure below spreads whatever it is given, so an array becomes
    // `{ '0': Command }` and a `Send` becomes `{}`: the routing is destroyed by
    // this wrapper and the run then completes as if the node had asked for
    // nothing. Measured, with these arms disabled: every downstream node ran,
    // the control was untouched, and no error was raised. A routing instruction
    // that vanishes without a word is worse than one that is refused, which is
    // what these arms are for.
    //
    // Both shapes ARE honoured by a raw `StateGraph` for an unwrapped node, so
    // the silence is this wrapper's doing rather than the dependency's.
    // see graph-node-return-shape.test.mjs › "refuses an array carrying a
    // Command, which this wrapper would otherwise flatten into a plain object"
    // and › "refuses a bare Send, which this wrapper would otherwise flatten
    // away entirely"
    //
    // The graph's OWN routing still works this way. `termination_check` and
    // `review_conclusion` return `Command` directly, and `routeChallenge`
    // builds the one that sends to `challenge_hypothesis` — that node itself
    // returns a plain object. All three are registered UNWRAPPED, and the
    // registration, not the return shape, is why this refusal cannot reach
    // them. see graph-node-return-shape.test.mjs › "still lets the graph's own
    // nodes return a Command"
    if (isRoutingInstruction(result)) {
      throw new Error(
        'lifecycle node returned routing (Command or Send): routing and graph-owned control are the graph\'s, not a node\'s',
      );
    }

    const { declaredLlmCalls: _ignoredDeclaredLlmCalls, ...update } = result;

    // `stopKind` is restored separately from the other nine: absent means "this
    // run has not stopped", and writing the key with an `undefined` value is a
    // different state from not writing it.
    const { stopKind, ...graphOwnedWithoutStopKind } = protectedControl;
    const graphOwned = {
      ...graphOwnedWithoutStopKind,
      llmCallsUsed: protectedControl.llmCallsUsed + readDeclaredLlmCalls(result),
    };

    // The node's own control update is the base only when it sent one; with no
    // update the current control is, so a graph-owned increment still lands.
    const control = withoutGraphOwnedControl(update.control ?? current);
    const controlUpdate = { ...control, ...graphOwned };

    return {
      ...update,
      control:
        stopKind === undefined ? controlUpdate : { ...controlUpdate, stopKind },
    };
  };
}

/**
 * One definition of "a count", derived from the domain schema rather than
 * restated here — see `LogicalCountSchema`.
 */
function isLogicalCount(value: unknown): value is number {
  return LogicalCountSchema.safeParse(value).success;
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
    ['resume counter', control.resumeCount],
  ] as const) {
    if (!isLogicalCount(value)) {
      throw new Error(`invalid ${field}`);
    }
  }
}

/**
 * Refuses persisted state this graph cannot read, naming the version it refused
 * on.
 *
 * `IncidentStateSchema` guards the `kind: 'start'` input, and nothing else: a
 * `kind: 'resume'` takes its state from the checkpointer, so the schema's
 * version literal never sees a restored checkpoint. Without this, state written
 * before the usage counters existed resumed to COMPLETION on the confirm route
 * and returned a control object the domain schema rejects — a run reported
 * complete with its spend absent.
 *
 * see hitl-resume-contract.test.mjs › "resuming ${persisted.label} with
 * ${label} fails loudly at the schema version boundary"
 */
function assertPersistedStateVersion(control: IncidentStateControl): void {
  if (control.schemaVersion !== INCIDENT_STATE_SCHEMA_VERSION) {
    throw new Error(
      `incompatible persisted state: schema version ${String(control.schemaVersion)}, ` +
        `this graph reads schema version ${String(INCIDENT_STATE_SCHEMA_VERSION)}`,
    );
  }

  if (control.statusRulesVersion !== STATUS_RULES_VERSION) {
    throw new Error(
      `incompatible persisted state: status-rules version ${String(control.statusRulesVersion)}, ` +
        `this graph reads status-rules version ${String(STATUS_RULES_VERSION)}`,
    );
  }
}

/**
 * Fails closed on a challenge counter that is not a count, and on a round
 * counter past the cap.
 *
 * "Is a count" is `isLogicalCount`, the same `LogicalCountSchema` the domain
 * exports and the logical budgets are checked with — deliberately not a second
 * hand-written spelling of it. It used to be one (`Number.isSafeInteger(x) &&
 * x >= 0`), which agreed with the schema by luck rather than by construction.
 *
 * The cap is the part that is genuinely this function's own: no schema in the
 * domain package expresses `MAX_CHALLENGE_ROUNDS`, because the graph is what
 * spends the rounds — see investigation-graph.test.mjs › "refuses a start state
 * one past the challenge round cap, which the domain schema accepts".
 */
function assertChallengeCounters(control: IncidentStateControl): void {
  if (
    !isLogicalCount(control.challengeRounds) ||
    control.challengeRounds > MAX_CHALLENGE_ROUNDS
  ) {
    throw new Error('invalid challenge round counter');
  }

  if (!isLogicalCount(control.reservedChallengeBudget)) {
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
    // Version first, for the reason `reviewConclusion` states: stale state is
    // refused for being stale, not for a counter that is only missing because
    // the state is stale.
    assertPersistedStateVersion(state.control);
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
      // A logical budget bounds what the graph may still SPEND on its own, so
      // it is read here rather than against a decision that has already
      // concluded: a run that reached a terminal stop kind keeps it, rather
      // than having an exhausted budget overwrite the finding.
      //
      // ⚠ This gates the AUTOMATIC edge only. The challenge route and the
      // human-review re-entry reach the cycle without passing here, bounded by
      // the challenge reserve and by the human respectively — so this is not
      // "an exhausted budget stops all further work", and the architecture
      // document says so in the same words.
      //
      // `budget-exhausted` is the existing stop kind for a spent budget — the
      // challenge reserve already terminates through it — so an exhausted
      // logical budget reads the same way rather than inventing one. Like that
      // reserve, the check runs after `termination_check` has been consulted,
      // which keeps this node the sole owner of the stop kind.
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
    // This node is where a resumed checkpoint re-enters the graph. The version
    // check runs FIRST so stale state is refused for the reason it is stale,
    // rather than surfacing as a counter error that reads like a bug.
    //
    // The challenge counters are asserted here for a reason no other site
    // covers, and the reason is the ROUTE rather than the count of sites — the
    // enumeration that used to be here went stale the moment AIC-75 added one.
    // A `confirm` decides nothing from these counters and reaches END without
    // entering a single wrapped node, so this is the only assertion standing on
    // that route; an unasserted value would be read for the first time by
    // whoever receives the finished control. `reject` and `add_hypothesis`
    // re-enter at wrapped nodes and are covered twice over.
    // see hitl-resume-contract.test.mjs › "refuses a current-version checkpoint
    // carrying a negative challenge round counter, and names the counter"
    assertPersistedStateVersion(state.control);
    assertLogicalBudgetCounters(state.control);
    assertChallengeCounters(state.control);
    const decision = ConclusionReviewDecisionSchema.parse(
      interrupt({
        kind: 'conclusion-review',
        runId: state.control.runId,
        conclusion: state.conclusion,
      }),
    );

    // Reaching here means the run was RESUMED: `interrupt()` throws on the
    // first pass, so everything below it executes once per resume and never on
    // the initial visit. That makes this the one site where a resume is
    // observable, and the graph — not a node — is what counts it.
    //
    // The increment rides on all three decision paths, `confirm` included:
    // that path used to carry no update at all, so a confirmed run would have
    // reported one resume fewer than it spent.
    //
    // Both halves rest on LangGraph's replay behaviour, which is a third party's
    // and can change under an upgrade, so neither is asserted here on faith:
    // see hitl-resume-contract.test.mjs › "counts one resume for a human
    // ${label} decision, however many nodes replay after it" and ›
    // "counts the resumes a human spends re-entering the graph without counting
    // the replayed nodes", and for the never-on-the-initial-visit half,
    // investigation-graph.test.mjs › "leaves resumeCount at zero on a run that
    // never pauses for a human"
    const resumedControl = {
      ...state.control,
      resumeCount: state.control.resumeCount + 1,
    };

    if (decision.action === 'confirm') {
      return new Command({ goto: END, update: { control: resumedControl } });
    }

    const control = controlWithoutStopKind(resumedControl);
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
      // Entering this node IS a logical investigation iteration, so this counts
      // every entry — but "every entry" is not "every way back into the cycle",
      // and the two re-entries differ from each other:
      //   - a human re-entry DOES pass through here, so it is counted, even
      //     though `maxIterations` does not gate it;
      //   - the challenge cycle re-enters at `execute_investigation` instead
      //     (see the edge near the bottom of this file), so it is neither
      //     counted here nor gated here — `MAX_CHALLENGE_ROUNDS` and the
      //     challenge reserve are what bound it.
      // see hitl-resume-contract.test.mjs › "maxIterations caps the automatic
      // loop-back edge while a ${route.label} re-entry is bounded by the human,
      // and iterationsUsed keeps counting across it"
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
        executionConfig !== undefined &&
        langGraphConfig !== undefined
      ) {
        // One snapshot read serves both checks below. It is skipped entirely
        // when this graph was built without a checkpointer, because `getState`
        // throws `No checkpointer set` there and would replace a refusal that
        // already names its reason — `Cannot use Command(resume=...) without
        // checkpointer` — with one about the wrong thing. see
        // hitl-resume-contract.test.mjs › "still refuses a resume with no
        // checkpointer for the reason it already gives"
        if (checkpointer !== undefined) {
          const snapshot = await graph.getState(langGraphConfig);

          // A thread that has never run answers with an EMPTY snapshot rather
          // than an error, so resuming a mistyped thread id used to reach
          // `normalize_incident` with no state at all and die reading
          // `control.humanReview` off `undefined` — a TypeError from the
          // graph's insides, telling the caller nothing about which of the two
          // things went wrong. It also left a checkpoint behind: `getState` on
          // the ghost id then reported a checkpoint and one pending task at
          // `normalize_incident` for a thread on which nothing ever ran. That
          // is the reason this refusal is here rather than inside a node — a
          // node can name the problem, and the half-started run is written
          // either way.
          //
          // The test is the ABSENCE OF `control`, not an empty task list: a run
          // that has finished has no pending task either, and resuming one is a
          // no-op this deliberately leaves alone.
          //
          // ⚠ Two limits, each with a row of its own rather than a sentence.
          //
          // A checkpoint that EXISTS while its `control` channel does not is
          // refused by this same message. That state is not the ghost above: it
          // reports a checkpoint id and a pending task, and its other eight
          // channels are populated. So the message names the absent CONTROL
          // rather than claiming the thread has no checkpoint or no state —
          // both of which would be false about it. see
          // hitl-resume-contract.test.mjs › "refuses a checkpoint whose control
          // channel is gone, without calling the thread empty"
          //
          // `control` present but MALFORMED — `null` from a hand-edited
          // checkpoint — is NOT caught here: `null !== undefined`, so it reaches
          // the identity check and still raises a TypeError. Unchanged from
          // before this guard existed and out of this item's scope, but pinned
          // so the gap is a known one. see hitl-resume-contract.test.mjs ›
          // "leaves a malformed control to the identity check, unrefused here"
          // see hitl-resume-contract.test.mjs › "refuses a resume under a
          // thread that has no checkpoint, naming the thread" and › "leaves no
          // checkpoint behind for the thread whose resume it refused"
          const values = snapshot.values as Partial<IncidentState> | undefined;
          if (values?.control === undefined) {
            throw new Error(
              `no resumable run on thread ${executionConfig.threadId}: no investigation control was checkpointed for it`,
            );
          }

          if (request.decision.action === 'add_hypothesis') {
            const targetsPendingInterrupt = snapshot.tasks.some(
              ({ interrupts }) =>
                interrupts.some(({ id }) => id === request.interruptId),
            );
            if (targetsPendingInterrupt) {
              assertHumanHypothesisIdIsAvailable(
                snapshot.values,
                request.decision,
              );
            }
          }
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
