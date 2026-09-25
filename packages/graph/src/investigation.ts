import {
  ConclusionReviewDecisionSchema,
  HypothesisSchema,
  INCIDENT_STATE_SCHEMA_VERSION,
  IncidentStateControlSchema,
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
 * Every control field that must be a logical count, paired with the word the
 * refusal names it by.
 *
 * Exported for one reason: the resume-path table that proves the guard has to
 * be DERIVED from this list rather than kept beside it. Two hand-maintained
 * lists of the same five fields is the shape `.claude/rules/invariants.md`
 * ("One mechanism, one implementation") tells you to replace with a check, and
 * this pair had already drifted — the table covered three while the guard
 * checked five, which left two counters with no row anywhere and the suite
 * green.
 *
 * What derivation buys, stated as what actually goes red rather than as what it
 * feels like it prevents: an entry added HERE cannot arrive without its rows,
 * because the rows are generated from this list. The row that fires is the one
 * checking an added entry names a field the domain declares a logical count,
 * and its sibling that no such field is left outside both graph guards.
 * see hitl-resume-contract.test.mjs › "covers every counter the graph's logical
 * budget guard checks, derived from the exported list rather than restated"
 * and › "leaves no logical-count control field unguarded between the two graph
 * guards"
 *
 * The labels are the refusal's own words rather than the field names, because
 * the resume rows assert on the message a caller actually sees.
 *
 * Frozen at BOTH levels. `as const` is type-level only and `Object.freeze` is
 * shallow, so freezing the outer array alone leaves each pair writable: an
 * in-process importer could rewrite one entry's field and silently stop that
 * counter being re-validated on the resume path while every refusal message
 * stayed correct. That sits outside this file's stated threat model — a caller
 * running in this process can supply the control value directly — but the deep
 * form costs one call and `packages/tools/src/contracts.ts` already uses it.
 */
export const LOGICAL_BUDGET_COUNTERS = Object.freeze(
  (
    [
      ['maxIterations', 'iteration budget'],
      ['llmCallBudget', 'llm call budget'],
      ['iterationsUsed', 'logical iteration counter'],
      ['llmCallsUsed', 'llm call counter'],
      ['resumeCount', 'resume counter'],
    ] as const satisfies readonly (readonly [keyof IncidentStateControl, string])[]
  ).map((entry) => Object.freeze(entry)),
);

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
 * Two nodes declare through it since AIC-94 — `createModelGenerateHypotheses`
 * and `createModelInterpretResidualEvidence` in `packages/roles`, each
 * returning `declaredLlmCalls: 1`. `challenge_hypothesis` does not, and
 * "deliberately" was the wrong word for it: it **cannot**. A `ChallengeResult`
 * carries `alternative` and `discriminatingTests` and nothing else, and
 * `parseChallengeResult` refuses a third key outright — so a model-backed
 * challenge role that returned a count would fail at runtime, not opt in. The
 * limit further down this block says exactly that; this line used to imply a
 * choice a later session could reverse.
 *
 * The two roles that DO declare are model-backed and need a provider
 * credential, and the arm the regression suite and the shipped benchmark run is
 * the replay-backed one, which declares nothing — so `llmCallsUsed` reads 0 on every run of THAT
 * arm by construction of it rather than by estimate. An unused channel reports
 * nothing, where a synthesised count would be cost evidence nobody measured.
 * see budget-policy.test.mjs › "measures a declared llm call count of zero on every run of the shipped arm"
 *
 * ⚠ The width matters, and two earlier wordings here were wrong at two
 * different widths: the first said no producer existed at all, and the
 * correction that replaced it said 0 on every BENCHMARK run. Neither holds. A
 * benchmark run declares whatever the nodes handed to it declare, and a probe
 * fixture drives the same calibration corpus to a non-zero count on all 24.
 * see benchmark-resource-evidence.test.mjs › "sources graph resource evidence from the executed control block and the trials it produced"
 *
 * ⚠ A second limit, and it is not the same one: consumption is folded in AFTER
 * the node ran, so a single declaration larger than the remaining budget is
 * recorded in full and caught at the next check. That is detection, not
 * pre-authorisation — and it is reachable today, by any node that declares more
 * than the budget leaves.
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

const CONTROL_FIELD_NAMES: readonly string[] = Object.freeze(
  Object.keys(IncidentStateControlSchema.shape),
);

/**
 * The control fields the schema lets be absent, asked of the schema rather than
 * listed here — a field that gains or loses its optionality carries this set
 * with it, and a hand-written copy is the one that goes stale.
 *
 * The question is asked by parsing rather than through a version-specific
 * `isOptional` accessor — and it asks for the PARSED VALUE, not merely that the
 * parse succeeded. `safeParse(undefined).success` alone is true for `.default(x)`,
 * `.catch(x)`, `z.any()` and `z.unknown()` as well as for `.optional()`. A
 * graph-owned field that gained a default would then stop being refused and
 * instead land `undefined`, be dropped by JSON, and be re-read as the default —
 * for `humanReview` that is the review gate quietly resetting itself, which is
 * the exact outcome this guard exists to prevent, downgraded from loud to
 * silent. Requiring `data === undefined` separates "may be absent" from "has a
 * value of its own when absent".
 *
 * ⚠ Uncovered today, and stated here rather than only in a pull request: no
 * control field carries a `.default()` or `.catch()`, so the strict and loose
 * forms classify the same single field and dropping `data === undefined`
 * reddens no row. It is protection against a schema change, and the row that
 * would back it does not exist until such a field does.
 *
 * see graph-owned-control-contract.test.mjs › "classifies every control field
 * the schema declares as graph-owned or node-writable" for the sibling
 * partition this mirrors.
 */
const OPTIONAL_CONTROL_FIELDS: ReadonlySet<string> = new Set(
  Object.entries(IncidentStateControlSchema.shape)
    .filter(([, fieldSchema]) => {
      const parsed = fieldSchema.safeParse(undefined);
      return parsed.success && parsed.data === undefined;
    })
    .map(([field]) => field),
);

/**
 * Refuses a control whose field is not the caller's OWN.
 *
 * The hazard is not a reader walking the prototype chain — it is the PARSE.
 * With an accessor defined on `Object.prototype` for a control field name,
 * `IncidentStateSchema.safeParse` returns a control on which that field is not
 * an own property, even when the input carried a correct own value: the write
 * lands on the inherited setter, or is dropped where there is none, and every
 * later read falls through to the getter. Measured on both accessor shapes; a
 * plain inherited DATA property is harmless and parses correctly.
 *
 * Which fields that reaches is not a fixed list. Today `runId` and `phase`
 * complete a run carrying the inherited string while the other eleven happen to
 * be refused downstream — but only because a string fails THEIR validators, not
 * because anything noticed the substitution. A string-typed field added to the
 * schema tomorrow joins the first group silently. So the guard names the real
 * property, ownership, rather than the fields that currently survive.
 *
 * ⚠ This closes the `kind: 'start'` path and only that path. A `kind: 'resume'`
 * takes its control from the checkpointer and never reaches this function; the
 * same substitution was live there — an inherited `humanReview` accessor
 * returning `false` completed a paused interactive run, skipped the identity
 * check and persisted a control that no longer parses — and is closed by three
 * other calls rather than by this one: `execute` on the restored control
 * (AIC-89), `reviewConclusion` on the object the run was built from (AIC-90),
 * and `pickGraphOwnedControl`, which is where a value the prototype
 * SUPPLIES ON READ stopped being launderable (AIC-92). Said here because a
 * reader landing on this function would otherwise infer that the class is
 * closed by it. ⚠ Nor is it closed by all four together: an inherited setter
 * that DEFINES the value on the target produces a genuine own data property,
 * which no ownership check can distinguish from an honest one. That shape is
 * closed OUTSIDE the graph and CONDITIONALLY, by `withDeclaredOwnValues` —
 * which `createSqliteCheckpointer` in `packages/persistence` wires, and which
 * a caller passing this graph their own `BaseCheckpointSaver` therefore does
 * not get. Where it is wired the checkpoint bytes are put back, so the run is
 * IMMUNE rather than warned and nothing here reports the attempt (AIC-93) —
 * immune on the shapes that module covers, which it enumerates as numbered
 * limits in its own header rather than leaving to this sentence.
 * see hitl-resume-contract.test.mjs › "keeps the run's own humanReview under
 * an inherited setter that writes an own property" and
 * checkpoint-serde-own-values.test.mjs › "states its limit: a checkpointer
 * this module did not build keeps the unrepaired serde"
 *
 * ⚠ Two limits of the check itself. It verifies that CONTROL owns its fields,
 * not that `state` owns `control` — a polluted `Object.prototype.control` is
 * stopped today only by LangGraph colliding with the pollution on its own
 * channel map, which is luck rather than a check. And a `Proxy` that lies
 * through `getOwnPropertyDescriptor` passes it; that is outside the threat
 * model, since a caller able to build one can supply the value directly.
 *
 * see graph-input-own-control.test.mjs › "refuses a start state whose control
 * field is supplied by an accessor on the prototype"
 */
function assertOwnControlFields(control: object): void {
  for (const field of CONTROL_FIELD_NAMES) {
    // `in` consults the prototype chain on purpose: that is exactly the
    // difference being detected. Present-but-not-own is the refusal; absent
    // entirely is fine, which is how an unset `stopKind` passes.
    if (field in control && !Object.hasOwn(control, field)) {
      throw ownControlFieldError(field);
    }
  }
}

/**
 * The one wording of the ownership refusal, because several guards raise it and
 * a caller should not have to learn a spelling per guard — the rule this
 * repository states as one mechanism, one implementation.
 *
 * Two causes, one invariant, and the shared PREFIX is the load-bearing part: a
 * caller matches "must carry its own <field>" and does not care which way the
 * field stopped being theirs.
 */
function ownControlFieldError(field: string): Error {
  return new Error(
    `investigation control must carry its own ${field}: an inherited or accessor-supplied field is not the caller's state`,
  );
}

function decisionFieldError(field: string, detail: string): Error {
  return new Error(
    `conclusion review decision must carry its own ${field}: ${detail}`,
  );
}

function missingControlFieldError(field: string): Error {
  return new Error(
    `investigation control must carry its own ${field}: the restored control has no value of its own for it`,
  );
}

/**
 * Reads one field of a caller's object as an OWN DATA PROPERTY, or `undefined`.
 *
 * The narrow sibling of `readExactOwnDataProperties`, for the case where the
 * shape is not fixed and only one field matters.
 */
function readOwnDataValue(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined;
}



/**
 * A caller's value, rebuilt from OWN DATA PROPERTIES ONLY, with no prototype.
 *
 * 🔴 The reason this exists rather than a check: zod builds its output by
 * ASSIGNING into a fresh object, so an own-writing `Object.prototype` setter
 * intercepts that assignment and defines the attacker's value as a genuine own
 * property of the result. Checking the caller's object then constrains nothing
 * about the object the graph acts on. Measured on an honest, complete
 * `add_hypothesis` resume with `Object.prototype.hypothesis` armed: accepted at
 * every arming window, `resumeCount: 1`, and the attacker's hypothesis in
 * persisted state, steering every node after it.
 *
 * So the decision the graph acts on is assembled here, never taken from the
 * parse. `Object.create(null)` has nothing behind it, and the copy is written
 * with `defineProperty` rather than assignment, so neither read nor write can
 * be intercepted.
 *
 * ⚠ The cap bounds DEPTH, not total work, and the difference is worth stating
 * because an earlier version of this sentence claimed boundedness outright.
 * Recursion stops at `OWN_COPY_MAX_DEPTH`, and anything deeper is carried by
 * reference rather than dropped — a decision is two levels deep by schema, so
 * the cap is slack, and keeping the value intact means the parse still judges
 * it. But the walk runs BEFORE the parse, so a caller's object with many shared
 * references costs more than the parse would have: measured, 802 own properties
 * reachable through sharing take ~1.75s, growing as k⁴, where `main`'s strict
 * parse rejected the unknown top-level key without descending at all. Not
 * reachable from JSON, which cannot express sharing, so this is an in-process
 * caller's own foot.
 *
 * ⚠ A `Proxy`, or an array carrying its own `map`, is outside the threat model
 * here as it is for `readOwnControl` and `assertOwnControlFields` — and here the
 * reason is specific rather than inherited. This function walks the caller's
 * object TWICE, once for the copy that is validated and once for the copy that
 * is returned, so an object that answers differently per walk can have one
 * validated and the other returned. Measured: a `Proxy` flipping on its third
 * trap pass had the boundary validate a `confirm` and return an
 * `add_hypothesis`. Two things contain it — `reviewConclusion` re-validates
 * whatever the boundary assembled, so only a decision the schema accepts can
 * survive, which is a decision the caller could have sent outright; and no
 * JSON-sourced caller can express either shape, so it takes an in-process
 * caller who could have called with the value directly.
 *
 * If a decision field ever becomes an ARRAY, `value.map` below is the
 * interception point, and the array in the validated copy keeps
 * `Array.prototype` where every other node in that copy has none.
 *
 * see hitl-resume-contract.test.mjs › "refuses an own-writing gadget that
 * rewrites a nested hypothesis field"
 */
const OWN_COPY_MAX_DEPTH = 4;

function ownDataCopy(
  value: unknown,
  prototype: object | null,
  depth = 0,
): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= OWN_COPY_MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => ownDataCopy(entry, prototype, depth + 1));
  }
  const rebuilt = Object.create(prototype) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
      Object.defineProperty(rebuilt, key, {
        value: ownDataCopy(descriptor.value, prototype, depth + 1),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return rebuilt;
}


/**
 * Parses a conclusion-review decision from what the caller OWNS, and reports an
 * attempted substitution instead of absorbing it.
 *
 * It REFUSES rather than repairing, which is this project's standing trade
 * (AIC-92): a repaired input is indistinguishable from one that was never
 * attacked, so the attempt is surfaced rather than silently corrected.
 *
 * Three failure shapes, all measured, and the third is why checking was
 * replaced by assembling:
 *
 * - **the discriminant** — an accessor named `action` makes the union return
 *   `confirm` for a caller who wrote `reject`; the run then resolves at END,
 *   `review_conclusion` never runs again, zero nodes replay, and the checkpoint
 *   records a completed, reviewed run.
 * - **an omitted field** — with `Object.prototype.hypothesis` armed, a caller
 *   sending `{ action: 'add_hypothesis' }` and nothing else PARSES, because the
 *   strict object reads the missing field off the prototype, and the attacker's
 *   hypothesis enters persisted state. The own-only parse refuses it, and the
 *   own-only parse refuses it by name.
 * - **the parse output itself** — zod builds its result by ASSIGNING into a
 *   fresh object, so an own-writing setter defines the attacker's value as a
 *   genuine own property of that result. A caller sending a complete, honest
 *   `add_hypothesis` then had the attacker's hypothesis enter persisted state
 *   at every arming window. No check on the CALLER's object can see this; only
 *   not using the parse output as the value can.
 *
 * 🔴 The first version compared an own-data read against `parsed.action` — a
 * plain `[[Get]]` — so a getter answering honestly ONCE and attacker-side
 * afterwards satisfied the guard and then decided the route. Two reads of one
 * property through one getter compare whatever the getter feels like. That is
 * why the value the graph acts on is ASSEMBLED from the caller's own
 * descriptors rather than read out of anything the parse produced — the
 * comparison that remains only reports the attempt.
 *
 * ⚠ It narrows what a caller may send. A decision whose `action` is the
 * caller's OWN accessor, or lives on a class prototype, no longer reaches the
 * graph — the same own-data convention `readExactOwnDataProperties` already
 * imposes on the input around it. Nothing in this repository builds one.
 *
 * ⚠ The precondition for the attack is WARMTH, and the cold path is not a
 * defence: zod builds the union's `propValues` lookup lazily, and armed at
 * construction the gadget makes zod's own builder throw. One ordinary decision
 * parse removes that. see hitl-resume-contract.test.mjs › "an ordinary resume
 * through the public API is enough to warm the decision union"
 *
 * see hitl-resume-contract.test.mjs › "refuses a read-accessor gadget rewriting
 * reject into confirm", › "refuses a read-accessor getter that answers honestly
 * once and attacker-side afterwards" and › "refuses a hypothesis the caller
 * never supplied"
 */
function parseCallerOwnedDecision(
  supplied: unknown,
): ConclusionReviewDecision | undefined {
  // TWO copies, and the prototypes are the whole difference between them.
  //
  // The one that is VALIDATED has none: a field the caller omitted then finds
  // nothing to read, so the schema refuses it instead of the prototype filling
  // it in.
  //
  // The one that is RETURNED has the ordinary prototype, because a null-prototype
  // object is observably different downstream — `deepStrictEqual` compares
  // prototypes, so one reaching persisted state changes what callers and tests
  // see. Both are written with `defineProperty`, which no inherited setter can
  // intercept, so the returned copy carries the caller's values either way.
  const ownOnly = ownDataCopy(supplied, null);
  const parsed = ConclusionReviewDecisionSchema.safeParse(ownOnly);
  if (!parsed.success) {
    // Told apart from an ordinary invalid decision: if the caller's object
    // parses while what they own does not, the difference IS the substitution,
    // and this project reports an attempt rather than absorbing it (AIC-92).
    if (ConclusionReviewDecisionSchema.safeParse(supplied).success) {
      throw new Error(
        'conclusion review decision must be built from fields the caller owns as data: it parses only with a field the caller does not own as a plain value',
      );
    }
    return undefined;
  }

  // What remains is DETECTION. Correctness is already settled above: the parse
  // ran on a copy with no prototype, so `ownOnly` carries the caller's own
  // action and nothing else could have supplied it. This asks the separate
  // question of whether an attempt was made, so it can be reported rather than
  // absorbed (AIC-92).
  //
  // An earlier version also refused an `undefined` caller action and checked
  // every declared field against the caller's object. Both became unreachable
  // when the validated copy lost its prototype — measured, neutering either
  // reddened nothing — so they are deleted rather than pinned. A guard that
  // cannot fail is not a guard; it is a comment that costs a branch.
  const suppliedAction = readOwnDataValue(ownOnly, 'action');
  const asSent = ConclusionReviewDecisionSchema.safeParse(supplied);
  if (
    asSent.success &&
    suppliedAction !== readOwnDataValue(asSent.data, 'action')
  ) {
    // The caller's OWN value is what the message names — never a fresh read of
    // the parsed one, which an accessor controls in content and length alike
    // and which reaches operator output verbatim.
    throw decisionFieldError(
      'action',
      `the caller supplied ${String(suppliedAction)}, which is not what parsing their object produced`,
    );
  }

  // NOT `parsed.data`: zod assembles that by assignment, which an own-writing
  // setter intercepts. The caller's own copy is what the graph acts on, and the
  // parse above is what proved it valid.
  return ownDataCopy(supplied, Object.prototype) as ConclusionReviewDecision;
}

/**
 * Every required control field is present, as the run's OWN value — the half
 * `assertOwnControlFields` cannot ask.
 *
 * That check asks only that a field which is PRESENT be own, which is the right
 * question for a `kind: 'start'` state: a field missing there must produce the
 * schema's parse error rather than an ownership one. A restored control has
 * already been parsed once, so a required field missing from it is not an
 * omission — it is damage, and it is the shape a swallowed write leaves behind
 * once the setter that swallowed it is gone.
 *
 * Left to `pickGraphOwnedControl` it is still refused, but only once a wrapped
 * node runs, and a `confirm` reaches END from `reviewConclusion` without
 * entering one. Measured before this call, on a control whose `humanReview` was
 * erased between the two deserializations: the run COMPLETED and wrote a
 * control `IncidentStateControlSchema` rejects.
 *
 * ⚠ Called after `assertPersistedStateVersion` and never before it: "required"
 * is a fact about the current schema, so an older checkpoint is missing fields
 * legitimately and must be refused for being stale instead.
 *
 * It also closes what `assertOwnControlFields` leaves: `Object.hasOwn` is true
 * for an own ACCESSOR, so that check's message overstates it. Here the
 * descriptor must carry a value.
 *
 * see hitl-resume-contract.test.mjs › "refuses a ${label} whose restored
 * control lost a required field, leaving the checkpoint intact"
 */
function assertRestoredControlFieldsPresent(control: object): void {
  for (const field of CONTROL_FIELD_NAMES) {
    if (OPTIONAL_CONTROL_FIELDS.has(field)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(control, field);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw missingControlFieldError(field);
    }
  }
}

/**
 * Reads the `control` a checkpoint restored, as an OWN DATA PROPERTY or not at
 * all.
 *
 * `values.control` would consult the prototype chain, which is the whole hazard:
 * a polluted `Object.prototype.control` makes an empty snapshot look like a
 * resumable run.
 */
function readOwnControl(values: unknown): object | undefined {
  // ⚠ A `Proxy` lying through `getOwnPropertyDescriptor` passes, as it does for
  // `assertOwnControlFields` — outside the threat model, since such a caller can
  // supply the value directly.
  //
  // The object this returns is NOT the object the run uses: `graph.invoke`
  // deserializes the checkpoint a second time. That is why `reviewConclusion`
  // carries its own ownership check — AIC-90 — rather than trusting this one.
  // see hitl-resume-contract.test.mjs › "reads the checkpoint twice per resume,
  // so one guard cannot cover both objects"

  if (typeof values !== 'object' || values === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(values, 'control');
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
    return undefined;
  }
  const control = descriptor.value;
  return typeof control === 'object' && control !== null ? control : undefined;
}

function parseInvestigationExecutionInput(
  input: unknown,
): InvestigationExecutionInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('invalid investigation execution input');
  }

  const start = readExactOwnDataProperties(input, ['kind', 'state']);
  if (start?.kind === 'start') {
    // Before the parse, because this is the only point that can see a
    // caller-supplied `stopKind` shadowed by an accessor — the parse refuses
    // such a state first, with a message about the input rather than about
    // ownership.
    const supplied = (start.state as { control?: unknown } | null)?.control;
    if (typeof supplied === 'object' && supplied !== null) {
      assertOwnControlFields(supplied);
    }

    const state = IncidentStateSchema.safeParse(start.state);
    if (state.success) {
      // And again after it, because the parse is what introduces the
      // non-ownership for the other twelve fields.
      assertOwnControlFields(state.data.control);
      return { kind: 'start', state: state.data };
    }
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
    const decision = parseCallerOwnedDecision(resume.decision);
    if (decision !== undefined) {
      return {
        kind: 'resume',
        interruptId: resume.interruptId,
        decision,
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
 * Absent is the ordinary case and means zero — a scripted node spends no LLM
 * call and declares nothing. It is no longer the ONLY case: two model-backed
 * roles have declared through here since AIC-94, which the
 * `InvestigationNodeResult` docblock above names. This sentence said "no node in this
 * repository declares anything" until that stopped being true, and it is the
 * header of the function on the producer's own path — so a session reading
 * that path was the one getting the retracted premise.
 * Present-but-not-a-count is a different case and throws:
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
 * Reads the graph-owned half of a control object, by the one list that names it
 * — as OWN DATA PROPERTIES, or not at all.
 *
 * ⚠ This function was the laundering primitive the ownership checks around it
 * could not see for a value the prototype SUPPLIES ON READ — which is the half
 * it closes, and not the whole class; the other half is at the end of this
 * comment. Worth naming plainly because it read as a copy loop. `defineOwnValue(picked, field, control[field])` re-defines the
 * field as own; `control[field]` is a plain `[[Get]]`, so a value the PROTOTYPE
 * supplied came back out of here owned. Ownership was restored carrying the
 * substitution, and `assertOwnControlFields` — at `execute`, and again in
 * `reviewConclusion` — then passed on the object built from it. A guard that
 * launders its own input defeats every guard downstream of it, whichever route
 * reached it, which is why the check belongs HERE and not on the routes: AIC-87,
 * 89 and 90 each closed a route and the class stayed open.
 *
 * An own data property is taken by its DESCRIPTOR, never through `[[Get]]`. An
 * own ACCESSOR is refused rather than invoked: nothing here produces one — the
 * schema parse, the deserializer's assignment and object spread all make data
 * properties — and calling a getter to decide whether a value is trustworthy is
 * the mistake this function already made once.
 *
 * ⚠ What happens when the field is NOT own splits in two, and the line is drawn
 * from the SCHEMA rather than from a field name, because the two halves are
 * genuinely different situations:
 *
 * - a field the schema REQUIRES cannot legitimately be missing from a control
 *   the graph is running on, so absent-as-own is REFUSED — in the same words
 *   the entry points use, and **without asking whether the prototype is still
 *   carrying it**. That condition was in the first version of this guard and it
 *   fails open: the mechanism is a swallowed WRITE, so a setter that takes the
 *   deserializer's one assignment and then deletes itself leaves the field
 *   absent with a pristine prototype. `field in control` is then false, and the
 *   field would land as an own `undefined` — which for `humanReview` is falsy at
 *   the `propose_conclusion` edge, makes `assertInteractiveRunIdentity` return
 *   early, and SHADOWS the prototype so nothing downstream can see anything
 *   wrong. The invariant is presence-as-an-own-data-property, not reachability
 *   at the moment the guard happens to look.
 *   see hitl-resume-contract.test.mjs › "refuses a required control field
 *   erased before a wrapped node runs on it"
 * - a field the schema lets be ABSENT — `stopKind`, on a run that has not
 *   stopped — is legitimately missing, and there is no way to tell "the caller
 *   omitted it" from "the caller omitted it and someone armed the prototype".
 *   So the prototype is simply not consulted and the field lands `undefined`.
 *   The attacker's value does not reach the control either way; the difference
 *   is that this half is IMMUNE rather than loud.
 *
 *   ⚠ What happens to that `undefined` afterwards is `stopKind`-specific and
 *   NOT derived: the wrapper below destructures `stopKind` by name and restores
 *   it only when it carries a value. So the classification here is general and
 *   the handling downstream is not. A second optional graph-owned field would
 *   land `undefined` here and be spread into the control as `undefined` there,
 *   which the schema accepts and JSON then drops — survivable, but not what
 *   this docstring would have promised. Whoever adds one owns that line too.
 *
 * That second half is not a concession to make a test pass — it is the
 * wrapper's existing contract, pinned since AIC-73 in
 * graph-owned-control-contract.test.mjs › "keeps graph-owned control intact
 * while Object.prototype carries a setter of that name", which requires a run
 * to survive an inherited accessor on every graph-owned field and write the
 * same control it would have written. Refusing the optional half would break
 * that for `stopKind` alone, on the start path, where nothing is being
 * substituted.
 *
 * ⚠⚠ WHAT THIS CANNOT DO, stated here because the rest of this comment reads
 * like closure. It decides OWNERSHIP, and an inherited setter that DEFINES the
 * value on the target makes the field genuinely own — the descriptor read below
 * then returns exactly what an honest run would. Nothing is left to detect, so
 * no ownership check anywhere closes that shape; `JSON.parse` is immune to it
 * where plain assignment is not, which put the remedy at the deserializer and
 * not here. AIC-93 took it: `withDeclaredOwnValues` restores the value the
 * checkpoint bytes declare before this function ever sees the control. It
 * repairs ONLY a diverged own data property, so the two shapes this function
 * refuses — a field the prototype supplies on read, and an own accessor —
 * arrive here exactly as the reviver left them.
 *
 * ⚠ That remedy is CONDITIONAL and this function cannot check the condition.
 * It is wired by `createSqliteCheckpointer`, and `createInvestigationGraph`
 * accepts any `BaseCheckpointSaver`, so a caller who builds their own
 * checkpointer runs this function against an unrepaired reviver — where the
 * own-writing shape is once again undetectable here.
 * see checkpoint-serde-own-values.test.mjs › "states its limit: a checkpointer
 * this module did not build keeps the unrepaired serde"
 * see hitl-resume-contract.test.mjs › "keeps the run's own humanReview under
 * that gadget on the off-contract pause route"
 * see checkpoint-serde-own-values.test.mjs › "leaves a swallowed write for the
 * graph to refuse rather than repairing it"
 *
 * see hitl-resume-contract.test.mjs › "refuses a control the prototype supplies
 * to a wrapped node, on a pending interrupt" and › "accepts a graph-owned field
 * that is absent rather than inherited"
 */
function pickGraphOwnedControl(
  control: IncidentStateControl,
): Pick<IncidentStateControl, GraphOwnedControlField> {
  const picked: Record<string, unknown> = {};
  for (const field of GRAPH_OWNED_CONTROL_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(control, field);
    if (descriptor === undefined) {
      if (!OPTIONAL_CONTROL_FIELDS.has(field)) throw ownControlFieldError(field);
      defineOwnValue(picked, field, undefined);
      continue;
    }
    if (!Object.hasOwn(descriptor, 'value')) throw ownControlFieldError(field);
    defineOwnValue(picked, field, descriptor.value);
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
 *
 * The path where this is load-bearing is the RESUME path, and only that one: a
 * `kind: 'start'` state is parsed by `IncidentStateSchema` first, so
 * `LogicalCountSchema` refuses every one of these counters before this function
 * is consulted. The start-path rows prove the schema instead, and say so — see
 * investigation-graph.test.mjs › "refuses ${invalidBudgetCounter.label} at the
 * input boundary, before a logical budget can be spent".
 *
 * The counters are `LOGICAL_BUDGET_COUNTERS`, exported rather than written out
 * here, because the resume-path table that covers them has to be derived from
 * the same list rather than maintained beside it. A hand-kept second copy is
 * the one nobody is looking at (`.claude/rules/invariants.md`, "One mechanism,
 * one implementation"), and this one had already drifted: the table covered
 * three of these counters while the guard checked five, so the guard could have
 * been neutralised on `maxIterations` and `llmCallBudget` with the suite green.
 * see hitl-resume-contract.test.mjs › "covers every counter the graph's logical
 * budget guard checks, derived from the exported list rather than restated"
 */
function assertLogicalBudgetCounters(control: IncidentStateControl): void {
  for (const [field, label] of LOGICAL_BUDGET_COUNTERS) {
    if (!isLogicalCount(control[field])) {
      throw new Error(`invalid ${label}`);
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
 * ${label} fails loudly at the schema version boundary" and
 * state-cutover.test.mjs › "refuses to resume a schema-version-4 checkpoint
 * paused at the HITL interrupt, because it predates typed predictions and
 * hypothesis cause"
 */
/**
 * What each older schema version is missing, keyed by the persisted version.
 * The next bump adds its own entry. A version with no entry, or one that is
 * not a number, gets no clause.
 * see state-cutover.test.mjs › "refuses to resume a checkpoint whose schemaVersion is not the current number: its string form, NaN, or absent"
 */
const PRIMARY_SCOPE_CLAUSE =
  ' State written before this version has no incident primaryScope and cannot be migrated without inventing one; start a new investigation from an intake that names its primaryScope.';
const MIGRATION_CLAUSES: ReadonlyMap<number, string> = new Map([
  [1, PRIMARY_SCOPE_CLAUSE],
  [2, PRIMARY_SCOPE_CLAUSE],
  [3, PRIMARY_SCOPE_CLAUSE],
  [
    4,
    ' State written under schema version 4 carries untyped predictions and no hypothesis cause and cannot be migrated without inventing them; start a new investigation.',
  ],
]);

function assertPersistedStateVersion(control: IncidentStateControl): void {
  if (control.schemaVersion !== INCIDENT_STATE_SCHEMA_VERSION) {
    // A persisted version BELOW the current one is not merely stale, and the
    // two clauses below are deliberately distinct because they are missing
    // different things:
    // - AIC-96 made `incident.primaryScope` required, and no state written
    //   before that carries one;
    // - AIC-123 made predictions typed and versioned and added the optional
    //   hypothesis cause; a schema-version-4 checkpoint already has
    //   `primaryScope` but carries untyped predictions and no hypothesis
    //   cause instead.
    // Neither gap has a value to invent that would not be a guess. see
    // state-cutover.test.mjs › "refuses to resume a schema-version-3
    // checkpoint paused at the HITL interrupt, because it predates
    // primaryScope" and › "refuses to resume a schema-version-4 checkpoint
    // paused at the HITL interrupt, because it predates typed predictions and
    // hypothesis cause"
    const migrationClause =
      typeof control.schemaVersion === 'number'
        ? (MIGRATION_CLAUSES.get(control.schemaVersion) ?? '')
        : '';
    throw new Error(
      `incompatible persisted state: schema version ${String(control.schemaVersion)}, ` +
        `this graph reads schema version ${String(INCIDENT_STATE_SCHEMA_VERSION)}.` +
        migrationClause,
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
    // The ownership check on the object the RUN uses, not the one `execute`
    // inspected. `execute` validates what `graph.getState` deserialized;
    // `graph.invoke` deserializes the checkpoint again and builds this state
    // from the second copy, so pollution armed between the two reads is unseen
    // there and lands here. Measured before this call: an accessor armed at any
    // turn in a 124-turn window completed the resume, skipped the identity
    // check below, and persisted a control the domain schema rejects.
    //
    // It REFUSES rather than repairing, and that is still the right division
    // of labour — but the serde AIC-92 declined has since landed, so the three
    // reasons it gave no longer read the same way. Two stand as accepted costs:
    // a second parse per load, and this repository owning behaviour the
    // dependency may change under an upgrade. The third — "repair ABSORBS the
    // attempt where refusal reports it" — does not apply to the shape the serde
    // was taken for, because for THAT shape no refusal was ever available: an
    // inherited setter that defines on its target leaves a genuine own data
    // property with nothing left to detect.
    //
    // So the two now divide by shape rather than by preference.
    // `withDeclaredOwnValues` repairs only a slot the reviver left as an own
    // data property whose value diverged from the checkpoint bytes; this call
    // keeps refusing the shapes it leaves alone, which is what stops the repair
    // from silencing the rows below. The decision and what it gives up are in
    // docs/decisions/control-ownership-boundary.md.
    // see checkpoint-serde-own-values.test.mjs › "leaves a swallowed write for
    // the graph to refuse rather than repairing it"
    //
    // ⚠ What this call still covers ALONE, because "the only ownership check
    // standing" was the first draft's answer and measurement says otherwise.
    // `assertRestoredControlFieldsPresent`, further down this same prologue,
    // refuses every REQUIRED field this one would have caught — so deleting
    // this call reddens nothing else in the suite.
    //
    // The residual is an OPTIONAL graph-owned field on the `confirm` route:
    // the presence check skips `stopKind` because absence is legitimate for it,
    // and a `confirm` reaches END without entering a wrapped node, so
    // `pickGraphOwnedControl` never sees it either. Measured with this call
    // removed: the run COMPLETES and the terminal stop kind is silently dropped
    // from disk — quiet damage on an optional field, which is what AIC-89
    // recorded about `stopKind`. That is the one row that reddens for this
    // call, and it is the row cited here rather than a scan that stays green.
    // see hitl-resume-contract.test.mjs › "refuses an inherited stopKind on the
    // route where no wrapped node runs"
    // see hitl-resume-contract.test.mjs › "refuses the pollution armed at a
    // turn inside the measured window"
    assertOwnControlFields(state.control);
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
    // see hitl-resume-contract.test.mjs › "refuses a negative challenge round
    // counter before a resumed ${label} executes another node"
    assertPersistedStateVersion(state.control);
    // AFTER the version check, and the order is the whole of why this call is
    // here rather than beside the ownership one above. "Required" is a fact
    // about the CURRENT schema, so a checkpoint written by an older one is
    // missing fields legitimately — it has to be refused for being stale, not
    // for being incomplete. Moving this one line up replaces six version-
    // boundary refusals with an ownership complaint about the first counter
    // that schema had not invented yet.
    // see hitl-resume-contract.test.mjs › "resuming ${persisted.label} with
    // ${label} fails loudly at the schema version boundary"
    assertRestoredControlFieldsPresent(state.control);
    assertLogicalBudgetCounters(state.control);
    assertChallengeCounters(state.control);
    // The value the resume delivered here — the boundary-parsed copy, not the
    // caller's raw object, which is precisely why this parse needs its own
    // protection: `parseInvestigationExecutionInput` runs synchronously before
    // `execute`'s first await, so a gadget armed one microtask later is
    // invisible to it and lands HERE. The AIC-90 two-read shape, on the
    // decision. see hitl-resume-contract.test.mjs › "refuses a read-accessor
    // gadget armed after the boundary has already read the decision"
    const suppliedDecision = interrupt({
      kind: 'conclusion-review',
      runId: state.control.runId,
      conclusion: state.conclusion,
    });
    const decision = parseCallerOwnedDecision(suppliedDecision);
    if (decision === undefined) {
      throw new Error('invalid conclusion review decision');
    }

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
        // hitl-resume-contract.test.mjs › "still refuses a ${label} resume
        // with no checkpointer for the reason it already gives"
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
          // "refuses a malformed control by name instead of leaving it to the
          // identity check"
          // see hitl-resume-contract.test.mjs › "refuses a resume under a
          // thread that has no checkpoint, naming the thread" and › "leaves no
          // checkpoint behind for the thread whose resume it refused"
          // An OWN read, not `values?.control`: a polluted
          // `Object.prototype.control` satisfies the optional chain and hands
          // this check a fabricated control, so the refusal below never fires
          // and `graph.invoke` runs on it. see hitl-resume-contract.test.mjs ›
          // "refuses a fabricated control supplied entirely by the prototype"
          const restored = readOwnControl(snapshot.values);
          if (restored === undefined) {
            throw new Error(
              `no resumable run on thread ${executionConfig.threadId}: no investigation control was checkpointed for it`,
            );
          }

          // The same ownership rule the start path applies, on the control the
          // CHECKPOINTER handed back. It has to run here — before the identity
          // check and before `graph.invoke` — because anything further on reads
          // the restored control and writes one back: a field the prototype is
          // supplying is already absent from the object that gets checkpointed,
          // and the run then persists a control the domain schema rejects.
          // Measured before this guard: `humanReview` and `phase` each left an
          // unparseable control on disk. see hitl-resume-contract.test.mjs ›
          // "leaves no unparseable control on disk when it refuses"
          //
          // ⚠ This check and `reviewConclusion`'s are two REFUSAL SITES, and
          // sites are not what closed the class. Each covers one object — this
          // one what `getState` deserialized, `reviewConclusion` what
          // `graph.invoke` built from a second read (AIC-90) — and a resume
          // that replayed some other node first reached neither, because
          // `pickGraphOwnedControl` read the field through the prototype and
          // handed it on as own. AIC-92 closed THAT READ inside
          // `pickGraphOwnedControl`.
          //
          // ⚠ "Tripwires that should never fire" is what an earlier draft
          // called these two, and it was wrong twice, so it is corrected rather
          // than softened. `reviewConclusion`'s call is the only thing between a
          // `confirm` and an inherited OPTIONAL field — the row is named there.
          // And no arrangement of these checks closes the class: an inherited
          // setter that DEFINES on the target yields a genuine own property,
          // which is why that shape is answered outside the graph entirely, by
          // the serde `createSqliteCheckpointer` wires (AIC-93). Immunity, not
          // a refusal: these calls never see it and nothing reports it.
          // see hitl-resume-contract.test.mjs › "keeps the run's own
          // humanReview under an inherited setter that writes an own property"
          //
          // What THIS call covers alone: pollution present for the FIRST
          // checkpoint read and gone by the second. Every other guard sees only
          // the object `graph.invoke` builds, so a control fabricated while it
          // was being inspected and clean by the time it is used reaches none
          // of them. Without a row for that, deleting this call reddened
          // nothing at all — measured — which by this repository's own rule
          // made it a guess rather than a guard.
          // see hitl-resume-contract.test.mjs › "refuses pollution that is gone
          // by the second checkpoint read"
          assertOwnControlFields(restored);

          // Refuses a resume on a persisted version this graph cannot read,
          // BEFORE the interrupt-matching and FINISHED-run no-op paths below
          // can return it silently. Without this, a FINISHED run whose
          // checkpoint predates `primaryScope` (AIC-96) has no pending
          // interrupt at all, so it never reached `assertPersistedStateVersion`
          // and resolved as if the resume had succeeded. After
          // `assertOwnControlFields`, so the version read here is the restored
          // control's own field and not one the prototype supplies.
          // see state-cutover.test.mjs › "refuses a
          // resume of a FINISHED v3 checkpoint that predates primaryScope,
          // rather than treating it as a no-op"
          assertPersistedStateVersion(restored as IncidentStateControl);

          // A resume names the interrupt it answers, and this refuses the one
          // case where that name is WRONG rather than merely stale: the thread
          // is waiting on an interrupt, and it is not this one. The caller is
          // answering a question that has already been replaced by a different
          // question, and LangGraph's answer was to replay the pending task
          // with the resume map unmatched — silently, so a caller who did not
          // compare interrupt ids read it as success. AIC-92.
          //
          // ⚠ It deliberately does NOT refuse when the thread is waiting on
          // NOTHING, and that half is the one worth reading twice. A run whose
          // lifecycle node threw — or whose process died mid-superstep — leaves
          // a pending TASK with zero pending interrupts, and a resume is the
          // only way to advance it: `execute` exposes no replay that carries no
          // interrupt id, `getState` is read-only, and `kind: 'start'`
          // overwrites the control. Refusing on `tasks.length > 0` instead, as
          // the first version of this did, makes every id a caller can send an
          // error and a crashed run UNRESUMABLE. That is a recovery path this
          // change has no business removing, and it was removed by accident
          // rather than chosen.
          //
          // ⚠ What allowing it cost, and what it costs now. An earlier draft
          // said "nothing is given up"; that was measurably false while the
          // own-writing gadget could ride this route to a substitution nothing
          // could detect. AIC-93 closed that at the serde WHERE THE SERDE IS
          // WIRED — `createSqliteCheckpointer` installs it and this graph
          // accepts any `BaseCheckpointSaver` — so on a checkpointer this
          // repository built the retry advances the crashed run on the control
          // the checkpoint bytes declare, and on one a caller built it does not.
          // see hitl-resume-contract.test.mjs › "keeps the run's own
          // humanReview under that gadget on the crashed-run retry route" and
          // checkpoint-serde-own-values.test.mjs › "states its limit: a
          // checkpointer this module did not build keeps the unrepaired serde"
          //
          // What is still given up is the REPORT: a resume that names a stale
          // id on a thread waiting on nothing is not refused, so an operator
          // learns nothing from it. That is the price of leaving a crashed run
          // its only way forward, and it is the trade this call takes
          // deliberately rather than by accident.
          // see hitl-resume-contract.test.mjs › "advances a run past a
          // transient node failure when the caller retries the same id" and ›
          // "refuses a stale ${label} decision while the run waits on a
          // different interrupt"
          //
          // A FINISHED run is the same shape for a different reason — nothing
          // pending at all — and resuming one stays the no-op that resolves.
          // see hitl-resume-contract.test.mjs › "resolves a resume of a run
          // that already finished, rather than calling it a missing checkpoint"
          const pendingInterruptIds = new Set(
            snapshot.tasks.flatMap(({ interrupts }) =>
              interrupts.map(({ id }) => id),
            ),
          );
          const targetsPendingInterrupt = pendingInterruptIds.has(
            request.interruptId,
          );
          if (pendingInterruptIds.size > 0 && !targetsPendingInterrupt) {
            throw new Error(
              `resume targets interrupt ${request.interruptId}, which is not the interrupt thread ${executionConfig.threadId} is waiting on: answering a superseded review would decide nothing`,
            );
          }

          if (
            request.decision.action === 'add_hypothesis' &&
            targetsPendingInterrupt
          ) {
            assertHumanHypothesisIdIsAvailable(
              snapshot.values,
              request.decision,
            );
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
