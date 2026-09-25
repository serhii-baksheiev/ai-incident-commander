import { Client } from 'langsmith';

export const OBSERVABILITY_LAYER = 'observability' as const;

const PERSISTED_METRIC_KEYS = [
  'unsupported_claim_rate',
  'evidence_coverage',
  'termination_correctness',
] as const;

/**
 * The resource axes this layer will persist, and the ONLY ones.
 *
 * `PERSISTED_RESOURCE_SCHEMA_VERSION` is the shape this layer can read. An
 * evidence object at any other version is refused rather than projected: the
 * fields it declares may mean something else, and publishing them under the
 * names below would be a measurement claim nobody made.
 */
const PERSISTED_RESOURCE_SCHEMA_VERSION = 2;
const PERSISTED_RESOURCE_KEYS = [
  'logicalIterationsUsed',
  'declaredLlmCallsUsed',
  'toolCallsUsed',
  'wallClockDurationMs',
  'retryCount',
  'resumeCount',
] as const;

/**
 * Resource axes a record MAY declare, held to the same count rule when present.
 *
 * Split from the list above rather than added to it, because a required token
 * axis would refuse every deterministic record: no model ran, so there is
 * nothing to declare, and an absent axis is the honest shape. Present-and-wrong
 * is still refused — the axes are as strictly checked as their required
 * neighbours, they are simply allowed not to be there.
 * see model-run-identity-correspondence.test.mjs › "carries every declared
 * resource axis in one of the two resource allowlists"
 * see benchmark-resource-evidence.test.mjs › "refuses a token axis that is
 * present and is not a count: inputTokensUsed" and › "refuses a token axis that
 * is present and is not a count: outputTokensUsed"
 *
 * The version above moved 1 -> 2 with them: the shape a record can carry
 * changed, and a reader that accepted a v1 record under the new shape would be
 * guessing that the absence was intentional rather than truncated.
 */
const PERSISTED_OPTIONAL_RESOURCE_KEYS = [
  'inputTokensUsed',
  'outputTokensUsed',
] as const;

const PERSISTED_BEHAVIOR_METRIC_KEYS = [
  'misleading_evidence_handling',
  'false_alert_correctness',
  'challenge_effect',
] as const;

/**
 * The run-metadata fields this layer publishes, split by whether the record
 * must declare them.
 *
 * They are a LIST rather than a hand-written literal because the projection now
 * reads each field as an own data property: a field named once in a literal and
 * once in a read is two spellings of the same fact, and the one nobody is
 * looking at is the one that drifts.
 *
 * The `satisfies` clauses hold them to `PersistedBenchmarkRunMetadata` in ONE
 * direction: a name neither list can spell is a compile error. They do not
 * prove the lists are complete — that direction is
 * `test/metric-path-prototype-safety.test.mjs` ›
 * "publishes every declared metadata field and nothing else", and its reach is
 * the FIXTURE's: it compares against the fields a real record declares, so a
 * field added to the type and never to `benchmarkVersions` is still dropped
 * silently with that test green.
 */
const PERSISTED_METADATA_KEYS = [
  'runId',
  'scenarioId',
  'graphVersion',
  'promptVersion',
  'toolsetVersion',
  'statusRulesVersion',
  'toolMode',
  'knowledgeSetVersion',
  'memoryEnabled',
  'humanReview',
] as const satisfies readonly (keyof PersistedBenchmarkRunMetadata)[];

// `temperature` is optional: no role sends one to the provider, so a run that
// declares none publishes none rather than a value that was never applied.
// see persistence-four-arm.test.mjs › "publishes no temperature key when the run metadata declares none"
const PERSISTED_OPTIONAL_METADATA_KEYS = [
  'temperature',
  'evaluatorVersion',
  'seed',
  'docsAvailable',
  'modelId',
  'modelProvider',
] as const satisfies readonly (keyof PersistedBenchmarkRunMetadata)[];

// The evaluator versions a record may declare: the accepted one and the
// structural one (AIC-105). A second spelling of the versions @aic/evals
// defines, because this package does not import evals; the persistence rows in
// structural-evaluator.test.mjs publish a record under each and refuse any other.
const PERSISTED_BEHAVIOR_EVALUATOR_VERSIONS: ReadonlySet<string> = new Set([
  'behavior-evaluators-v0.2',
  'behavior-evaluators-v0.3',
]);

const PERSISTED_BEHAVIOR_METRIC_REASONS = new Set([
  'passed',
  'misleading-evidence-not-investigated',
  'expected-evidence-missing',
  'root-cause-mismatch',
  'misleading-evidence-not-reconciled',
  'insufficient-investigation',
  'incorrect-outcome',
  'challenge-not-observed',
  'leader-observation-missing',
  'no-investigation-change',
  'leader-change-mismatch',
]);

interface NativeDataset {
  readonly id: string;
}

interface NativeProject {
  readonly id: string;
}

interface NativeExample {
  readonly id: string;
}

interface NativeExampleCreate {
  readonly id: string;
  readonly dataset_id: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly outputs: Readonly<Record<string, unknown>>;
}

export interface LangSmithPersistenceClient {
  createDataset(name: string): Promise<NativeDataset>;
  createExamples(examples: NativeExampleCreate[]): Promise<NativeExample[]>;
  createProject(payload: Readonly<{
    projectName: string;
    referenceDatasetId: string;
  }>): Promise<NativeProject>;
  createRun(payload: Readonly<{
    id: string;
    name: string;
    run_type: 'chain';
    inputs: Readonly<Record<string, unknown>>;
    outputs: Readonly<Record<string, unknown>>;
    extra: Readonly<{ metadata: Readonly<Record<string, unknown>> }>;
    project_name: string;
    reference_example_id: string;
  }>): Promise<void>;
  createFeedback(feedback: Readonly<{
    runId: string;
    sessionId: string;
    key: string;
    score: number;
  }>): Promise<unknown>;
}

export interface PersistedBenchmarkRunMetadata {
  readonly runId: string;
  readonly scenarioId: string;
  readonly graphVersion: string;
  readonly promptVersion: string;
  readonly toolsetVersion: string;
  readonly statusRulesVersion: string;
  readonly evaluatorVersion?: string;
  readonly toolMode: 'live' | 'replay';
  readonly knowledgeSetVersion: string;
  readonly memoryEnabled: boolean;
  readonly humanReview: false;
  readonly temperature?: number;
  readonly seed?: number;
  readonly docsAvailable?: boolean;
  // Optional for the reason `BenchmarkVersions` states where they originate: a
  // run with no model declares neither, and an absent identity is not the same
  // claim as a declared placeholder one.
  readonly modelId?: string;
  readonly modelProvider?: string;
}

export interface PersistedBenchmarkRecord {
  readonly experimentId: string;
  readonly exampleId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly scenario: Readonly<{
    id: string;
    groundTruth: unknown;
  }>;
  readonly metadata: PersistedBenchmarkRunMetadata;
}

export interface PersistedBenchmarkEvaluation {
  readonly experimentId: string;
  readonly exampleId: string;
  readonly runId: string;
  readonly actualStopKind: string;
  readonly metrics: Readonly<
    Record<string, Readonly<{ key: string; score: number; claimCount?: number }>>
  >;
  readonly resources?: Readonly<Record<string, unknown>>;
  readonly notApplicable?: Readonly<
    Partial<Record<(typeof PERSISTED_BEHAVIOR_METRIC_KEYS)[number], string>>
  >;
  readonly behaviorMetrics?: Readonly<
    Partial<
      Record<
        (typeof PERSISTED_BEHAVIOR_METRIC_KEYS)[number],
        Readonly<{
          evaluatorVersion: string;
          key: string;
          score: number;
          reason: string;
        }>
      >
    >
  >;
  readonly predictionGap?: Readonly<Record<(typeof PERSISTED_PREDICTION_GAP_KEYS)[number], unknown>>;
}

/**
 * The fields of the prediction-gap diagnostic (AIC-119 slice 4, owner ruling
 * D1 item 7) a result may carry. It is published at `outputs.predictionGap`
 * and never as feedback, because it is a diagnostic, not a metric.
 * see persistence-four-arm.test.mjs › "publishes a declared predictionGap at outputs.predictionGap and as no feedback row"
 */
const PERSISTED_PREDICTION_GAP_KEYS = [
  'stopKind',
  'leaderId',
  'leaderStatus',
  'highestStatus',
  'leaderConfirmedPredictions',
  'finalCorroborated',
  'finalSupported',
  'sufficientFromCorroborated',
  'stalledLeaderLacksConfirmedPrediction',
  'stalledOther',
] as const;

/**
 * The scalar type each prediction-gap field carries. A value of another type
 * is refused by name, as every sibling projection in this file refuses its own.
 * see persistence-four-arm.test.mjs › "refuses a predictionGap field whose value is not of that field's scalar type, and publishes no run for it"
 */
const PREDICTION_GAP_FIELD_TYPES: Readonly<
  Record<(typeof PERSISTED_PREDICTION_GAP_KEYS)[number], 'string' | 'number' | 'boolean'>
> = {
  stopKind: 'string',
  leaderId: 'string',
  leaderStatus: 'string',
  highestStatus: 'string',
  leaderConfirmedPredictions: 'number',
  finalCorroborated: 'boolean',
  finalSupported: 'boolean',
  sufficientFromCorroborated: 'boolean',
  stalledLeaderLacksConfirmedPrediction: 'boolean',
  stalledOther: 'boolean',
};

const PREDICTION_GAP_TYPE_WORDS = {
  string: 'a string or absent',
  number: 'a finite number',
  boolean: 'a boolean',
} as const;

export interface PersistedBenchmarkExperiment {
  readonly records: readonly PersistedBenchmarkRecord[];
  readonly results: readonly PersistedBenchmarkEvaluation[];
}

export function createLangSmithClient(): LangSmithPersistenceClient {
  return new Client({ omitTracedRuntimeInfo: true });
}

type OwnIdentity = Readonly<{
  runId: string;
  exampleId: string;
  experimentId: string;
}>;

/**
 * Compares two identities that are already own projections.
 *
 * It used to compare six `[[Get]]`s, three per side, which is why it could pass
 * on a record and a result that both carried none of them: each comparison read
 * the SAME inherited value on both sides and found it equal. Taking projections
 * makes that shape unrepresentable — a missing own field is refused where it is
 * read, before anything reaches here.
 */
function assertResultIdentity(record: OwnIdentity, result: OwnIdentity): void {
  if (
    result.runId !== record.runId ||
    result.exampleId !== record.exampleId ||
    result.experimentId !== record.experimentId
  ) {
    throw new Error('benchmark result identity must match its run record');
  }
}

/**
 * The one own-data-property read this layer uses, and the reason it exists.
 *
 * A plain `target[key]` is a `[[Get]]` that walks the prototype chain, so a
 * field a run never declared is supplied by `Object.prototype` and published as
 * if the run had produced it. Reading the own DESCRIPTOR answers the question
 * this layer actually asks — *did this record carry that value?* — and an
 * accessor, inherited or own, is refused rather than invoked: a field read
 * through THIS function never comes from a getter.
 *
 * 🔴 That is a claim about this FUNCTION, and it does not extend to the layer.
 * Many reads in this file are still plain `[[Get]]`s, and they are NOT
 * inventoried here — deliberately, because each successive draft of the list
 * fixed the last omission and introduced the next. That is what
 * `.claude/rules/invariants.md` asks of prose about a mechanism ("State the
 * limits — and test them"): a hand-maintained inventory across a file this size
 * has nothing checking it, so it is wrong the day it is written and wronger
 * after the next edit.
 *
 * So this header states the boundary instead of enumerating it: **nothing here
 * entitles a reader to conclude that no published value came from a getter.**
 * What the file as a whole is held to is mechanical rather than stated here —
 * see observability-own-value-audit.test.mjs ›
 * "reads every caller-supplied field of the observability layer through ownValue",
 * which recomputes the inventory from this file's AST on every run and names
 * each violation by line. Read that test's header for what it does NOT cover.
 *
 * ⚠ And one shape this function does NOT close, on any path: a `Proxy` traps
 * `getOwnPropertyDescriptor`, so a proxied container answers this read with
 * whatever it likes. Prototype pollution is the threat model; a proxy is not.
 *
 * `undefined` therefore means "not an own data property of this object",
 * which every caller here already treats as absent.
 */
function ownValue(target: unknown, key: string): unknown {
  if (typeof target !== 'object' || target === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor === undefined || !Object.hasOwn(descriptor, 'value')
    ? undefined
    : descriptor.value;
}

/**
 * The typed own reads the rest of this file uses, so that no caller-supplied
 * field is read twice: once to check it and once to publish it.
 *
 * `ownValue` answers "is this an own data property", which is the right question
 * and the wrong type — every call site would otherwise narrow `unknown` itself,
 * and a site that forgets is indistinguishable from one that did it right. These
 * three narrow once, at the read.
 *
 * `requireOwn*` throws rather than returning a default, for the reason
 * `requireResourceEvidence` gives about dropped axes: a fabricated identity is
 * worse than a refused run, and an absent own field is exactly the case where
 * the old plain `[[Get]]` published an inherited one.
 */
function ownString(target: unknown, key: string): string | undefined {
  const value = ownValue(target, key);
  return typeof value === 'string' ? value : undefined;
}

/**
 * A native identity the provider returned, or a refusal that names it.
 *
 * 🔴 `requireOwnString` refuses only an ABSENT field, and `typeof '' === 'string'`,
 * so a client answering `{ id: '' }` published a whole experiment whose every
 * example carried `dataset_id: ""`. That is a present field carrying no identity,
 * and the gate this feeds — AIC-19 — accepts evidence only when it is "tied to
 * native LangSmith IDs", which an empty string is not. An identity that
 * identifies nothing is worse than an absent one, because it reads as evidence.
 * see persisted-benchmark-reference.test.mjs › "records an absent publication as absent with its reason, never as an empty identity"
 */
function requireNativeIdentity(target: unknown, key: string, subject: string): string {
  const value = requireOwnString(target, key, subject);
  // `/^\s*$/.test(value)` rather than `value.trim().length`: the own-value audit
  // scans this file's source for a plain `[[Get]]` on caller data and cannot tell
  // a method on a primitive from a property read on an object. Keeping the shape
  // out of the file is cheaper than an exemption, and an exemption here would be
  // the one place a reader checks when a credential-shaped value leaks.
  if (/^\s*$/.test(value)) {
    throw new Error(
      `${subject} carried an empty ${key}: a native identity that identifies nothing is not evidence, and publishing under it would name a dataset nobody can open`,
    );
  }
  return value;
}

function requireOwnString(target: unknown, key: string, subject: string): string {
  const value = ownString(target, key);
  if (value === undefined) {
    throw new Error(`${subject} must carry its own ${key}`);
  }
  return value;
}

/**
 * An own read of one array element.
 *
 * `records[0]` on an empty array is a chain walk: `Object.prototype['0']`
 * fabricates a whole record, and the `=== undefined` guard that follows it then
 * passes. Index reads on caller arrays go through here.
 */
function ownElement(source: unknown, index: number): unknown {
  return ownValue(source, String(index));
}

/**
 * An own read of an array-valued container, refusing anything that is not one.
 *
 * The container itself is the hazard `requireMetrics` already documents for
 * `metrics`: an experiment owning no `records` picks up an inherited array and
 * publishes a whole run nobody submitted.
 */
function requireOwnArray(target: unknown, key: string, subject: string): readonly unknown[] {
  const value = ownValue(target, key);
  if (!Array.isArray(value)) {
    throw new Error(`${subject} must carry its own ${key}`);
  }
  return value;
}

/**
 * The write half of the same hazard, and it is a separate function because
 * refusing to READ a polluted value is only half the job.
 *
 * `target[key] = value` is an ordinary `[[Set]]`: it walks the prototype chain,
 * and an inherited ACCESSOR named like the field swallows the write — the
 * setter runs, no own property is created, and the field vanishes from the
 * published record. CreateDataProperty semantics cannot be intercepted by the
 * prototype chain — the qualifier is load-bearing, since a `Proxy` traps
 * `defineProperty` and a frozen target throws. Every call site passes a freshly
 * created local object, which is neither.
 */
function defineOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

type OwnRecord = OwnIdentity &
  Readonly<{
    threadId: string | undefined;
    scenarioId: string;
    groundTruth: unknown;
    metadata: unknown;
    metadataScenarioId: string | undefined;
  }>;

type OwnResult = OwnIdentity & Readonly<{ actualStopKind: unknown }>;

/**
 * The own projection of one caller-supplied record, taken once at the top of
 * the loop that publishes it.
 *
 * Every field below was read straight off the caller's object at the point it
 * was published, so a record owning none of them published an inherited
 * identity, an inherited scenario and an inherited thread under a real run.
 * Projecting once is what makes the publishing code below unable to read the
 * chain: it has a plain local object in hand, and `nested` reads of `scenario`
 * and `metadata` go through their own reads here.
 */
function ownRecord(record: unknown): OwnRecord {
  const scenario = ownValue(record, 'scenario');
  const metadata = ownValue(record, 'metadata');
  // `metadata` is REQUIRED, not merely own-read. Before this change a record
  // carrying no metadata threw on the way to publication; own-reading it without
  // requiring it turned that refusal into a successful-looking run named
  // `benchmark:` with an empty metadata block — which reads downstream exactly
  // like a run that declared no graph, prompt, toolset or status-rules version.
  // Dropping an inherited block was the point; publishing a hollow one in its
  // place is the same lie in the other direction.
  if (typeof metadata !== 'object' || metadata === null) {
    throw new Error('benchmark record must carry its own metadata');
  }
  return {
    runId: requireOwnString(record, 'runId', 'benchmark record'),
    exampleId: requireOwnString(record, 'exampleId', 'benchmark record'),
    experimentId: requireOwnString(record, 'experimentId', 'benchmark record'),
    // The one field the type requires and this projection reads softly, and the
    // asymmetry is deliberate: an absent thread id publishes `undefined` rather
    // than refusing the run. `threadId` names a conversation for a human to find
    // later; it decides nothing and no aggregate reads it, so an absent one is a
    // missing convenience rather than a claim nobody made. The identity triple
    // and the scenario id are refused because a run published under them asserts
    // something. If that ever stops being true — if a thread id starts deciding
    // anything — this line becomes a `requireOwnString` like its neighbours.
    threadId: ownString(record, 'threadId'),
    scenarioId: requireOwnString(scenario, 'id', 'benchmark record scenario'),
    groundTruth: ownValue(scenario, 'groundTruth'),
    metadata,
    metadataScenarioId: requireOwnString(metadata, 'scenarioId', 'benchmark record metadata'),
  };
}

/** The result half of the same projection. */
function ownResult(result: unknown): OwnResult {
  return {
    runId: requireOwnString(result, 'runId', 'benchmark result'),
    exampleId: requireOwnString(result, 'exampleId', 'benchmark result'),
    experimentId: requireOwnString(result, 'experimentId', 'benchmark result'),
    actualStopKind: ownValue(result, 'actualStopKind'),
  };
}

function projectRunMetadata(
  metadata: PersistedBenchmarkRunMetadata,
): Record<string, unknown> {
  const declaredEvaluatorVersion = ownValue(metadata, 'evaluatorVersion');
  if (
    declaredEvaluatorVersion !== undefined &&
    !(
      typeof declaredEvaluatorVersion === 'string' &&
      PERSISTED_BEHAVIOR_EVALUATOR_VERSIONS.has(declaredEvaluatorVersion)
    )
  ) {
    throw new Error('benchmark evaluator version is not supported');
  }
  // Read own, write own — the two loops below replaced a literal plus three
  // conditional assignments, and each half was a separate hazard. The literal
  // was safe in itself, since object-literal definition never consults the
  // prototype, but its VALUES came through `metadata.<field>`, so an absent
  // field published an inherited one under this run's name. The three
  // assignments were ordinary `[[Set]]`s, which an inherited accessor swallows,
  // leaving a record that declares a versioned evaluator its own metadata does
  // not carry.
  const projected: Record<string, unknown> = {};
  for (const field of PERSISTED_METADATA_KEYS) {
    defineOwn(projected, field, ownValue(metadata, field));
  }
  for (const field of PERSISTED_OPTIONAL_METADATA_KEYS) {
    const value = ownValue(metadata, field);
    if (value !== undefined) defineOwn(projected, field, value);
  }
  return projected;
}

function requireMetrics(
  result: PersistedBenchmarkEvaluation,
): Record<
  (typeof PERSISTED_METRIC_KEYS)[number],
  Readonly<{ key: string; score: number; claimCount?: number }>
> {
  // The CONTAINER is read own-only too, not just the metrics inside it: a result
  // that never declared `metrics` would otherwise pick up an inherited object
  // and publish three headline quality scores in one go. An absent container
  // reports itself as the first missing metric BY NAME rather than crashing on
  // an undefined index — a crash is not a diagnosis, and this layer's refusals
  // say what was missing.
  const metrics = ownValue(result, 'metrics');
  return Object.fromEntries(
    PERSISTED_METRIC_KEYS.map((key) => {
      const metric = ownValue(metrics, key);
      if (metric === undefined || ownValue(metric, 'key') !== key) {
        throw new Error(`benchmark result is missing metric: ${key}`);
      }
      // Absent and malformed are different failures, and this file argues the
      // point itself where the resource schema version is read: reporting them
      // the same way sends the reader looking for the wrong problem. A metric
      // that owns its name but no score of its own is not missing — it is a
      // metric whose score would otherwise be taken off the prototype and
      // published as a figure no evaluator computed.
      const score: unknown = ownValue(metric, 'score');
      // `Number.isFinite`, not `typeof === 'number'`: the sibling resource check
      // refuses a non-finite figure and this one admitted NaN and Infinity, so
      // the loosest of the three checks in this file was the one on the score
      // that reaches the feedback stream. The item names this beside the
      // by-reference return; implementing half of that sentence silently would
      // read as having implemented all of it.
      // `typeof` first, then finiteness: `Number.isFinite` refuses a non-number
      // but does not NARROW one, so without the type guard the fresh pair below
      // is `{ key: string; score: unknown }` and only a cast makes it compile.
      // A cast that stands in for a check is the shape this file spends its
      // length arguing against.
      if (typeof score !== 'number' || !Number.isFinite(score)) {
        throw new Error(`benchmark result metric has no score of its own: ${key}`);
      }
      // A FRESH pair, not the caller's object. Returning `metric` published
      // whatever OWN properties the caller had hung on it straight into
      // `outputs.metrics` — inherited ones do not serialise, so the prototype
      // itself never crossed the wire — and the two reads below that used to
      // take `key` and `score` off it again were plain `[[Get]]`s on caller
      // data, checked here and read there.
      if (key !== 'unsupported_claim_rate') return [key, { key, score }];
      // The rate's denominator travels with it when the evaluation owns one.
      // see persistence-four-arm.test.mjs › "publishes claimCount on unsupported_claim_rate when the evaluation owns a non-negative safe integer one"
      const claimCount: unknown = ownValue(metric, 'claimCount');
      if (claimCount === undefined) return [key, { key, score }];
      if (typeof claimCount !== 'number' || !Number.isSafeInteger(claimCount) || claimCount < 0) {
        throw new Error(`benchmark result metric claim count is not a count: ${key}`);
      }
      return [key, { key, score, claimCount }];
    }),
  ) as Record<
    (typeof PERSISTED_METRIC_KEYS)[number],
    Readonly<{ key: string; score: number; claimCount?: number }>
  >;
}

/**
 * The behavior metrics an arm declares not applicable, each with its reason,
 * or nothing when the evaluation declares none. Read own-only and refused by
 * name when malformed, like the behavior metrics beside it.
 * see persistence-four-arm.test.mjs › "publishes a declared notApplicable map at outputs.notApplicable"
 */
function requireNotApplicable(
  result: PersistedBenchmarkEvaluation,
): Readonly<Record<string, string>> | undefined {
  const declared = ownValue(result, 'notApplicable');
  if (declared === undefined) return undefined;
  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
    throw new Error('benchmark result notApplicable is not an object');
  }
  const behaviorKeys = new Set<string>(PERSISTED_BEHAVIOR_METRIC_KEYS);
  const projected: Record<string, string> = {};
  for (const key of Object.keys(declared)) {
    const reason = ownValue(declared, key);
    if (!behaviorKeys.has(key)) {
      throw new Error(`benchmark result notApplicable names an unknown behavior metric: ${key}`);
    }
    if (typeof reason !== 'string' || reason === '') {
      throw new Error(`benchmark result notApplicable needs a reason: ${key}`);
    }
    defineOwn(projected, key, reason);
  }
  return projected;
}

/**
 * The prediction-gap diagnostic a result declares, or nothing when it declares
 * none. Read own-only; a field the diagnostic does not declare is refused by
 * name, before anything is sent.
 * see persistence-four-arm.test.mjs › "refuses a predictionGap carrying a key the diagnostic does not declare, and publishes no run for it"
 */
function requirePredictionGap(
  result: PersistedBenchmarkEvaluation,
): Readonly<Record<string, unknown>> | undefined {
  const declared = ownValue(result, 'predictionGap');
  if (declared === undefined) return undefined;
  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
    throw new Error('benchmark result predictionGap is not an object');
  }
  const known = new Set<string>(PERSISTED_PREDICTION_GAP_KEYS);
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(declared)) {
    if (!known.has(key)) {
      throw new Error(`benchmark result predictionGap names an unknown field: ${key}`);
    }
    const value = ownValue(declared, key);
    if (value === undefined) continue;
    const expected = PREDICTION_GAP_FIELD_TYPES[key as (typeof PERSISTED_PREDICTION_GAP_KEYS)[number]];
    const matches =
      expected === 'string'
        ? typeof value === 'string'
        : expected === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === 'boolean';
    if (!matches) {
      throw new Error(
        `benchmark result predictionGap field ${key} must be ${PREDICTION_GAP_TYPE_WORDS[expected]}`,
      );
    }
    defineOwn(projected, key, value);
  }
  return projected;
}

/**
 * Projects resource evidence, or refuses it.
 *
 * Absent is not an error: every record written before this evidence existed
 * carries none, and the generic benchmark path publishes none by design.
 *
 * PRESENT is held to the throwing standard `requireBehaviorMetrics` uses rather
 * than the dropping one `requireMetrics` uses, and the difference matters: a
 * silently dropped resource axis reads downstream as "this run spent nothing on
 * that axis", which is the one reading that must never be manufactured. An
 * unknown schema version or a missing declared field is therefore refused
 * before the run is created. An UNDECLARED extra property is dropped by the
 * projection — it is not a claim this layer is being asked to publish.
 */
function requireResourceEvidence(
  result: PersistedBenchmarkEvaluation,
): Readonly<Record<string, number>> | undefined {
  // The container is own-read for the same reason `requireMetrics` gives about
  // `metrics`: a result declaring no resources of its own would otherwise pick
  // up an inherited block and publish six spend figures nobody measured — the
  // one reading this layer must never manufacture.
  const evidence = ownValue(result, 'resources');
  if (evidence === undefined) return undefined;

  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) {
    throw new Error('benchmark resource evidence is not an object');
  }

  // OWN data properties only, the idiom `readDeclaredLlmCalls` uses in the graph
  // for the same hazard: read through the prototype chain and a polluted
  // `Object.prototype.resumeCount` supplies a count the run never declared —
  // manufacturing the exact reading this function exists to refuse. This was a
  // private copy of `ownValue` until every metric path needed the same read; one
  // implementation, per `.claude/rules/invariants.md`.
  const own = (key: string): unknown => ownValue(evidence, key);

  // Absent version and wrong version are different failures: one is evidence
  // that forgot to say what it is, the other is evidence this layer cannot
  // read. Reporting them the same way sends the reader looking for the wrong
  // problem.
  const schemaVersion = own('schemaVersion');
  if (schemaVersion === undefined) {
    throw new Error('benchmark resource evidence missing schemaVersion');
  }
  if (schemaVersion !== PERSISTED_RESOURCE_SCHEMA_VERSION) {
    throw new Error(
      `benchmark resource schema version is not supported: ${String(schemaVersion)}`,
    );
  }

  // Built with CreateDataProperty semantics, NOT assignment. `projected[key] =`
  // is an ordinary [[Set]] that walks the prototype chain, so an inherited
  // ACCESSOR named like an axis swallows the write: no own property is created,
  // the axis vanishes from the published outputs — reading downstream as "spent
  // nothing on that axis" — and the feedback projection then reads the
  // inherited getter back out and publishes a number no run declared. Refusing
  // to READ a polluted value is only half the job if the WRITE can still be
  // intercepted. `requireMetrics` above already builds this way.
  const entries: [string, number][] = [
    ['schemaVersion', PERSISTED_RESOURCE_SCHEMA_VERSION],
  ];
  const requireCount = (key: string, value: unknown): number => {
    // The same rule the graph applies to its own counters: a count is a
    // non-negative safe integer. Hoisted out of the required loop when the
    // optional axes arrived, so the two lists cannot drift into two standards —
    // an optional axis checked more loosely is the one a fabricated token count
    // would come through.
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`benchmark resource evidence ${key} is not a count`);
    }
    return value;
  };
  for (const key of PERSISTED_OPTIONAL_RESOURCE_KEYS) {
    const value = own(key);
    // Absent is the deterministic path and is not an error. Present is held to
    // the same standard as a required axis.
    if (value !== undefined) entries.push([key, requireCount(key, value)]);
  }
  for (const key of PERSISTED_RESOURCE_KEYS) {
    const value = own(key);
    if (value === undefined) {
      throw new Error(`benchmark resource evidence missing ${key}`);
    }
    // Restated rather than imported because this layer keeps its own outbound
    // vocabulary — but it must not be LOOSER than the graph's, or a negative
    // duration crosses the boundary as evidence.
    entries.push([key, requireCount(key, value)]);
  }
  return Object.fromEntries(entries);
}

function requireBehaviorMetrics(
  result: PersistedBenchmarkEvaluation,
  evaluatorVersion: string | undefined,
): Readonly<
  Partial<
    Record<
      (typeof PERSISTED_BEHAVIOR_METRIC_KEYS)[number],
      Readonly<{
        evaluatorVersion: string;
        key: string;
        score: number;
        reason: string;
      }>
    >
  >
> {
  // The container is read own-only for the same reason its fields are: an
  // inherited `behaviorMetrics` object would be read as a DECLARATION here, and
  // the paired check below is precisely what decides whether this run measured
  // behaviour at all.
  const declared = ownValue(result, 'behaviorMetrics');
  if ((declared === undefined) !== (evaluatorVersion === undefined)) {
    throw new Error(
      'behavior metric evaluator version and behavior metrics must be declared together',
    );
  }
  if (declared === undefined) return {};
  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
    throw new Error('benchmark result behavior metrics is not an object');
  }

  const declaredKeys = new Set<string>(PERSISTED_BEHAVIOR_METRIC_KEYS);
  const projected: Record<string, Readonly<{
    evaluatorVersion: string;
    key: string;
    score: number;
    reason: string;
  }>> = {};
  // `Object.entries` is already own-and-enumerable, so the ITERATION was never
  // the exposure. Each metric's FIELDS were: a metric carrying an own `key`,
  // `score` and `evaluatorVersion` but no own `reason` picked up an inherited
  // one, passed the declared-reason check below, and was published as a quality
  // claim the evaluator never made.
  for (const [key, inbound] of Object.entries(declared)) {
    const metricEvaluatorVersion = ownValue(inbound, 'evaluatorVersion');
    const metricScore = ownValue(inbound, 'score');
    const metricReason = ownValue(inbound, 'reason');
    if (!declaredKeys.has(key) || ownValue(inbound, 'key') !== key) {
      throw new Error(`benchmark result has unknown behavior metric: ${key}`);
    }
    // The metric's own version must be the record's, and a known one: a v0.3
    // metric inside a record that declares v0.2 is two semantics under one name.
    if (
      evaluatorVersion === undefined ||
      !PERSISTED_BEHAVIOR_EVALUATOR_VERSIONS.has(evaluatorVersion) ||
      metricEvaluatorVersion !== evaluatorVersion
    ) {
      throw new Error(`behavior metric evaluator version mismatch: ${key}`);
    }
    if (metricScore !== 0 && metricScore !== 1) {
      throw new Error(`behavior metric score must be zero or one: ${key}`);
    }
    if (
      typeof metricReason !== 'string' ||
      !PERSISTED_BEHAVIOR_METRIC_REASONS.has(metricReason)
    ) {
      throw new Error(`behavior metric reason is not declared: ${key}`);
    }
    // Same CreateDataProperty reasoning as the resource projection above in
    // this file: an inherited accessor named like a behavior metric would
    // otherwise swallow this write. The values are the own ones read above, so
    // the object published here carries nothing the inbound metric did not own.
    defineOwn(projected, key, {
      evaluatorVersion: metricEvaluatorVersion,
      key,
      score: metricScore,
      reason: metricReason,
    });
  }
  return projected;
}

function createNativeExamples(
  datasetId: string,
  records: readonly OwnRecord[],
): NativeExampleCreate[] {
  const runNumbers = new Map<string, number>();
  return records.map((record) => {
    const runNumber = (runNumbers.get(record.scenarioId) ?? 0) + 1;
    runNumbers.set(record.scenarioId, runNumber);
    return {
      id: record.exampleId,
      dataset_id: datasetId,
      inputs: { scenarioId: record.scenarioId, runNumber },
      // `groundTruth` reaches the dataset verbatim, which is why the scenario
      // container is own-read before we get here: a record owning no `scenario`
      // used to publish an inherited one, ground truth included.
      outputs: { groundTruth: record.groundTruth },
    };
  });
}

type OwnExperiment = Readonly<{
  records: readonly OwnRecord[];
  results: readonly unknown[];
}>;

/**
 * Projects one caller-supplied experiment, or refuses it.
 *
 * Both containers are own-read for the reason `requireMetrics` gives about the
 * `metrics` container: an experiment owning neither `records` nor `results`
 * picked up inherited arrays and published an entire run under identities it
 * never carried. The per-record projection happens here too, so everything
 * downstream of this function holds plain local objects.
 */
function requireExperiment(experiment: unknown): OwnExperiment {
  const rawRecords = requireOwnArray(experiment, 'records', 'benchmark experiment');
  const results = requireOwnArray(experiment, 'results', 'benchmark experiment');
  if (rawRecords.length !== results.length) {
    throw new Error('benchmark records and results must have the same length');
  }
  // An index loop, not `map`: `map` skips a sparse HOLE and leaves one in the
  // result, so the hole would be discovered later as an absent record rather
  // than here as a record that carries nothing of its own. `ownElement` reads
  // each index as an own property, which is what makes a hole read `undefined`
  // instead of `Object.prototype[index]`.
  const records: OwnRecord[] = [];
  for (let index = 0; index < rawRecords.length; index += 1) {
    records.push(ownRecord(ownElement(rawRecords, index)));
  }
  // Emptiness is checked BEFORE the index read, not after it. `records` is our
  // own array, but an index read on an EMPTY array walks its prototype like any
  // other — with `Object.prototype['0']` planted, an experiment of
  // `{ records: [], results: [] }` passed a `records[0] === undefined` guard on
  // an inherited object and its `experimentId` reached `createProject` as the
  // project name. Provenance is not the property that matters; emptiness is.
  // (`ownElement` would also close it, and re-taints: it returns a caller value
  // by design, so the audit would then treat this projection as caller data.)
  if (records.length === 0) {
    throw new Error('benchmark experiment must contain at least one record');
  }
  const firstRecord = records[0] as OwnRecord;
  if (records.some(({ experimentId }) => experimentId !== firstRecord.experimentId)) {
    throw new Error('benchmark records must belong to one experiment');
  }
  return { records, results };
}

async function persistPreparedExperiment({
  client,
  datasetId,
  experiment,
}: Readonly<{
  client: LangSmithPersistenceClient;
  datasetId: string;
  experiment: OwnExperiment;
}>): Promise<{ readonly projectId: string; readonly runIds: readonly string[] }> {
  // The same empty-array read as in `requireExperiment` above, guarded the same
  // way and for the same reason.
  if (experiment.records.length === 0) {
    throw new Error('benchmark experiment must contain at least one record');
  }
  const firstRecord = experiment.records[0] as OwnRecord;
  const createdProject = await client.createProject({
    projectName: firstRecord.experimentId,
    referenceDatasetId: datasetId,
  });
  // The client is injected, so its response is caller-supplied too — the same
  // read `dataset.id` gets in the plural entry point above.
  const projectId = requireNativeIdentity(createdProject, 'id', 'created project');
  const runIds: string[] = [];

  for (const [index, record] of experiment.records.entries()) {
    const rawResult = ownElement(experiment.results, index);
    if (rawResult === undefined) {
      throw new Error('benchmark result is missing for its run record');
    }
    const result = ownResult(rawResult);
    assertResultIdentity(record, result);
    runIds.push(record.runId);
    const metrics = requireMetrics(rawResult as PersistedBenchmarkEvaluation);
    const resources = requireResourceEvidence(rawResult as PersistedBenchmarkEvaluation);
    const notApplicable = requireNotApplicable(rawResult as PersistedBenchmarkEvaluation);
    const predictionGap = requirePredictionGap(rawResult as PersistedBenchmarkEvaluation);
    // Own-read, the same way `projectRunMetadata` reads this field further down
    // this function. This is the pairing input that decides whether the run measured
    // behaviour at all, so a `[[Get]]` here let an inherited version admit
    // versioned metrics while the published metadata declared none — the record
    // shape this whole change exists to make impossible. A non-string reads as
    // absent rather than being cast: the paired-declaration guard then refuses,
    // which is the honest answer to metrics whose version nobody stated.
    const declaredEvaluatorVersion = ownValue(record.metadata, 'evaluatorVersion');
    const behaviorMetrics = requireBehaviorMetrics(
      rawResult as PersistedBenchmarkEvaluation,
      typeof declaredEvaluatorVersion === 'string'
        ? declaredEvaluatorVersion
        : undefined,
    );
    // A metric is either scored or not applicable, never both.
    // see persistence-four-arm.test.mjs › "refuses a result that both scores a behavior metric and declares it not applicable"
    for (const key of Object.keys(notApplicable ?? {})) {
      if (Object.hasOwn(behaviorMetrics, key)) {
        throw new Error(`benchmark result both scores and declares not applicable: ${key}`);
      }
    }

    await client.createRun({
      id: record.runId,
      name: `benchmark:${record.metadataScenarioId}`,
      run_type: 'chain',
      project_name: record.experimentId,
      inputs: {
        exampleId: record.exampleId,
        scenarioId: record.metadataScenarioId,
        threadId: record.threadId,
      },
      outputs: {
        actualStopKind: result.actualStopKind,
        metrics,
        behaviorMetrics,
        // One key per dimension, never merged into a score, and absent when the
        // run was not measured.
        ...(resources === undefined ? {} : { resources }),
        ...(notApplicable === undefined ? {} : { notApplicable }),
        ...(predictionGap === undefined ? {} : { predictionGap }),
      },
      extra: {
        metadata: projectRunMetadata(record.metadata as PersistedBenchmarkRunMetadata),
      },
      reference_example_id: record.exampleId,
    });

    for (const metric of [
      ...Object.values(metrics),
      ...Object.values(behaviorMetrics),
    ]) {
      await client.createFeedback({
        runId: record.runId,
        sessionId: projectId,
        key: metric.key,
        score: metric.score,
      });
    }

    // Each resource axis gets its OWN feedback key beside the quality ones —
    // the item asks for "separate feedback/output keys" preserving every
    // individual dimension, and a dimension that reaches only `outputs` is one
    // surface short of that. Nothing is blended: no composite key is emitted,
    // and `schemaVersion` is metadata about the shape rather than an axis, so
    // it stays out of the score stream.
    //
    // The optional token axes are read from the PROJECTION rather than from a
    // second list: `requireResourceEvidence` inserts them only when the record
    // declared them, so iterating what it built publishes a token axis exactly
    // when one was measured and never manufactures a zero for a run with no
    // model.
    // see benchmark-resource-evidence.test.mjs › "publishes a token axis only
    // when the record declared one"
    if (resources !== undefined) {
      for (const key of [
        ...PERSISTED_RESOURCE_KEYS,
        ...PERSISTED_OPTIONAL_RESOURCE_KEYS,
      ]) {
        const score = resources[key];
        if (score === undefined) continue;
        await client.createFeedback({
          runId: record.runId,
          sessionId: projectId,
          key,
          score,
        });
      }
    }
  }
  return { projectId, runIds };

}

/**
 * The caller's client, or `undefined` when they supplied none.
 *
 * Three answers, not two, and collapsing them is how this got wrong twice:
 *
 *   - **absent** — no own `client` at all: fall back to the real one.
 *   - **present and `undefined`** — `{ client: undefined }`, which is what
 *     forwarding an optional (`client: options.client`) spells under this
 *     repository's compiler settings. An own data property, and a caller who
 *     wrote it meant "use the default", so it falls back too.
 *   - **present and unreadable** — an accessor. `ownValue` refuses accessors,
 *     so reading it alone would send a caller who passed a lazily-built client
 *     to the LIVE workspace instead of to theirs. It is refused, because this
 *     file's rule is that a present field which cannot be read is refused
 *     rather than defaulted.
 *
 * 🔴 It is shared by all three entry points deliberately. The first version
 * guarded only the plural one, and every caller in this repository uses the
 * singular — so the refusal sat on the path nobody takes while the path
 * everybody takes kept the behaviour it was meant to close. A
 * `security-scanner` probe found it by making a real outbound call to the
 * live workspace. `verifyPersistedBenchmarkReference` read its slot with plain
 * `ownValue` until round 2 of AIC-120 found the same gap there: an own
 * ACCESSOR `client` read as absent and the read-back call fell through to the
 * live default client.
 * see persist-boundary-refusals.test.mjs › the CLIENT_SLOT_ENTRY_POINTS entry
 * named 'verifyPersistedBenchmarkReference', whose generated row
 * "refuses ${name} options whose client is an own accessor" runs it
 */
function ownClient(options: unknown): LangSmithPersistenceClient | undefined {
  if (typeof options !== 'object' || options === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(options, 'client');
  if (descriptor === undefined) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) {
    throw new Error('persist options carry a client that is not an own data property');
  }
  return descriptor.value as LangSmithPersistenceClient | undefined;
}

/**
 * ⚠ The options object is caller-supplied, so it is read own-only rather than
 * destructured — a destructuring default fires only on `undefined`, so an
 * inherited `client` used to suppress the default and send every outbound call
 * in this layer wherever it pointed. Keep the reads own if you change this
 * signature; the audit will tell you if you do not.
 */
/**
 * What a publication actually created, so a caller can cite it.
 *
 * 🔴 Both entry points created a dataset and a project, read their native ids to
 * use them, and then returned `void` — so a run could publish and learn nothing
 * about what it had published. AIC-19 accepts final evidence only when it is
 * "tied to native LangSmith IDs/URLs and exact candidate SHA", which a caller
 * holding no identity cannot supply. No new request is made to obtain these:
 * every value here was already in hand.
 * see persisted-benchmark-reference.test.mjs › "records the native dataset, project, example and run identities the publication returned"
 */
export interface PersistedBenchmarkReference {
  readonly datasetId: string;
  readonly datasetName: string;
  readonly projects: readonly Readonly<{ experimentId: string; projectId: string }>[];
  readonly exampleIds: readonly string[];
  readonly runIds: readonly string[];
}

export async function persistBenchmarkExperiments(
  options: Readonly<{
    client?: LangSmithPersistenceClient;
    datasetName: string;
    experiments: readonly PersistedBenchmarkExperiment[];
  }>,
): Promise<PersistedBenchmarkReference> {
  // The options object is read own-only, and this is the surface that made the
  // whole item worth doing: `client = createLangSmithClient()` as a
  // destructuring default fires only on `undefined`, so an INHERITED `client`
  // suppressed the default and sent every outbound call in this layer wherever
  // it pointed — dataset, examples, runs and every feedback, ground truth
  // included, with no own `client` key anywhere on the object.
  const client = ownClient(options) ?? createLangSmithClient();
  const datasetName = requireOwnString(options, 'datasetName', 'persist options');
  const rawExperiments = requireOwnArray(options, 'experiments', 'persist options');

  if (datasetName.length === 0) {
    throw new Error('datasetName must not be empty');
  }
  if (rawExperiments.length === 0) {
    throw new Error('at least one benchmark experiment is required');
  }

  // Projected before anything is published, and every index read own: the old
  // `experiments[0]` was a chain walk on an empty array, and `.slice(1)` does
  // its own per-index `[[Get]]`s inside the engine, which no audit of this file
  // can see. Reading the indices here is what takes that out of the engine's
  // hands.
  const experiments: OwnExperiment[] = [];
  for (let index = 0; index < rawExperiments.length; index += 1) {
    experiments.push(requireExperiment(ownElement(rawExperiments, index)));
  }
  // Unreachable in practice — the raw list was refused when empty above, and the
  // loop pushes one entry per raw element — and kept anyway, because this is the
  // site that reads index 0 and this file's rule is that a refusal belongs where
  // the read is. Recorded as unreachable rather than left for a reader to
  // mistake for a live guard: deleting it does not turn the suite red.
  if (experiments.length === 0) {
    throw new Error('at least one benchmark experiment is required');
  }
  const firstExperiment = experiments[0] as OwnExperiment;

  const nativeExampleIds = new Set(
    firstExperiment.records.map(({ exampleId }) => exampleId),
  );
  for (const experiment of experiments.slice(1)) {
    if (
      experiment.records.length !== nativeExampleIds.size ||
      experiment.records.some(({ exampleId }) => !nativeExampleIds.has(exampleId))
    ) {
      throw new Error(
        'benchmark experiments must share the same native example identities',
      );
    }
  }

  const dataset = await client.createDataset(datasetName);
  const datasetId = requireNativeIdentity(dataset, 'id', 'created dataset');
  await client.createExamples(
    createNativeExamples(datasetId, firstExperiment.records),
  );
  const projects: { experimentId: string; projectId: string }[] = [];
  const runIds: string[] = [];
  for (const experiment of experiments) {
    const persisted = await persistPreparedExperiment({ client, datasetId, experiment });
    projects.push({
      experimentId: (experiment.records[0] as OwnRecord).experimentId,
      projectId: persisted.projectId,
    });
    runIds.push(...persisted.runIds);
  }

  return Object.freeze({
    datasetId,
    datasetName,
    projects: Object.freeze(projects.map((entry) => Object.freeze({ ...entry }))),
    exampleIds: Object.freeze([...nativeExampleIds]),
    runIds: Object.freeze(runIds),
  }) as PersistedBenchmarkReference;
}

/** Reads its options own-only for the same reason as its plural sibling above. */
export async function persistBenchmarkExperiment(
  options: Readonly<{
    client?: LangSmithPersistenceClient;
    datasetName: string;
    experiment: PersistedBenchmarkExperiment;
  }>,
): Promise<PersistedBenchmarkReference> {
  const suppliedClient = ownClient(options);
  const experiment = ownValue(options, 'experiment');
  if (experiment === undefined) {
    throw new Error('persist options must carry its own experiment');
  }
  return persistBenchmarkExperiments({
    ...(suppliedClient === undefined
      ? {}
      : { client: suppliedClient as LangSmithPersistenceClient }),
    datasetName: requireOwnString(options, 'datasetName', 'persist options'),
    experiments: [experiment as PersistedBenchmarkExperiment],
  });
}

/**
 * The read-back half of a LangSmith publication: confirming that what a
 * `PersistedBenchmarkReference` claims to have created is still readable, not
 * merely that `createDataset`/`createRun` returned without throwing.
 *
 * AIC-120: a persist call can succeed while the workspace it wrote to is not
 * the one a later reader queries — a wrong-region endpoint being the concrete
 * case `resolveTracingConfig` above already documents for tracing. Verifying
 * the reference this way is what lets `scripts/final-holdout-publication.mjs`
 * tell `ingestion-failed` (the write itself refused) apart from
 * `readback-failed` (the write returned identities that do not read back).
 */
export interface LangSmithReadbackClient {
  readDataset(payload: Readonly<{ datasetId: string }>): Promise<unknown>;
  readProject(payload: Readonly<{ projectId: string }>): Promise<unknown>;
  listRuns(payload: Readonly<{ projectId: string }>): AsyncIterable<unknown>;
  listExamples(payload: Readonly<{ datasetId: string }>): AsyncIterable<unknown>;
}

/** What a successful verification confirms it read back. */
export interface VerifiedBenchmarkReference {
  readonly datasetId: string;
  readonly projectIds: readonly string[];
  readonly exampleCount: number;
  readonly runCount: number;
}

/**
 * Confirm that every native identity a `PersistedBenchmarkReference` names
 * reads back from LangSmith. Rejects, naming what was missing BY COUNT rather
 * than by dumping the payload, when the dataset, a project, a run id or an
 * example id does not read back. A read that throws propagates — there is no
 * retry here, the same rule `runLiveModelLane`'s header already states for
 * publication itself.
 *
 * The counts below are accumulated in a loop rather than read off
 * `Array.prototype.length` on the caller's own arrays: every own-property read
 * in this file goes through `ownValue`/`requireOwn*`, and a `.length` taken
 * directly off a caller-supplied array is exactly the plain `[[Get]]`
 * `test/observability-own-value-audit.test.mjs` exists to catch.
 * see final-evaluation-publication.test.mjs › "verifyPersistedBenchmarkReference resolves counts when every id in the reference reads back from the fake client"
 */
export async function verifyPersistedBenchmarkReference(
  options: Readonly<{
    client?: LangSmithReadbackClient;
    reference: PersistedBenchmarkReference;
  }>,
): Promise<VerifiedBenchmarkReference> {
  const suppliedClient = ownClient(options) as LangSmithReadbackClient | undefined;
  const client = suppliedClient ?? (createLangSmithClient() as unknown as LangSmithReadbackClient);
  const reference = ownValue(options, 'reference');
  if (reference === undefined) {
    throw new Error('verify options must carry their own reference');
  }

  const datasetId = requireOwnString(reference, 'datasetId', 'benchmark reference');
  const projects = requireOwnArray(reference, 'projects', 'benchmark reference');
  const exampleIds = requireOwnArray(reference, 'exampleIds', 'benchmark reference');
  const runIds = requireOwnArray(reference, 'runIds', 'benchmark reference');

  const readbackDataset = await client.readDataset({ datasetId });
  const readbackDatasetId = requireNativeIdentity(readbackDataset, 'id', 'read-back dataset');
  if (readbackDatasetId !== datasetId) {
    throw new Error(
      `read-back dataset id ${readbackDatasetId} disagrees with the requested datasetId ${datasetId}`,
    );
  }

  const projectIds: string[] = [];
  for (const project of projects) {
    const projectId = requireOwnString(project, 'projectId', 'benchmark reference project');
    await client.readProject({ projectId });
    projectIds.push(projectId);
  }

  const seenRunIds = new Set<string>();
  for (const projectId of projectIds) {
    for await (const run of client.listRuns({ projectId })) {
      const id = ownString(run, 'id');
      if (id !== undefined) seenRunIds.add(id);
    }
  }
  let runCount = 0;
  let missingRunCount = 0;
  for (const runId of runIds) {
    runCount += 1;
    if (typeof runId !== 'string' || !seenRunIds.has(runId)) missingRunCount += 1;
  }
  if (missingRunCount > 0) {
    throw new Error(
      `benchmark reference names ${missingRunCount} run id(s) that did not read back from listRuns`,
    );
  }

  const seenExampleIds = new Set<string>();
  for await (const example of client.listExamples({ datasetId })) {
    const id = ownString(example, 'id');
    if (id !== undefined) seenExampleIds.add(id);
  }
  let exampleCount = 0;
  let missingExampleCount = 0;
  for (const exampleId of exampleIds) {
    exampleCount += 1;
    if (typeof exampleId !== 'string' || !seenExampleIds.has(exampleId)) missingExampleCount += 1;
  }
  if (missingExampleCount > 0) {
    throw new Error(
      `benchmark reference names ${missingExampleCount} example id(s) that did not read back from listExamples`,
    );
  }

  return Object.freeze({
    datasetId: readbackDatasetId,
    projectIds: Object.freeze(projectIds),
    exampleCount,
    runCount,
  });
}

/**
 * The exact set `@langchain/core` honours, in its own order
 * (`@langchain/core/dist/utils/callbacks.js` `isTracingEnabled`), compared the
 * way it compares: strict equality against `'true'`.
 *
 * Reading a narrower set than the tracer does is not a cosmetic gap. A flag
 * this list omits installs the tracer while the key check below never runs, so
 * graph inputs and evidence statements are posted with no credential and the
 * rejection is swallowed as a background warning. Accepting a value the tracer
 * rejects fails the other way: the run stops on a missing key it did not need,
 * or runs untraced believing it is traced.
 */
const TRACING_FLAG_VARIABLES = [
  'LANGSMITH_TRACING_V2',
  'LANGCHAIN_TRACING_V2',
  'LANGSMITH_TRACING',
  'LANGCHAIN_TRACING',
] as const;

/**
 * Tracing configuration resolved from an environment, never from `process.env`
 * directly, so it is decidable in a test without mutating the process.
 *
 * The api key is deliberately absent from the result: callers need to know
 * whether tracing is on and which project it targets, and the LangSmith SDK
 * reads the key from the environment itself.
 */
export type TracingConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{ enabled: true; project: string }>;

/**
 * Resolve LangSmith tracing configuration.
 *
 * The enablement flags are exactly those of `TRACING_FLAG_VARIABLES` above; the
 * api key and project each accept the `LANGSMITH_*` name and its legacy
 * `LANGCHAIN_*` twin, which is the pairing the SDK itself resolves
 * (`langsmith/dist/utils/env.js` `getLangSmithEnvironmentVariable`).
 *
 * Enabled tracing without an api key THROWS rather than returning disabled:
 * silently-off tracing is the failure this function exists to prevent. That is
 * the only delivery failure it detects — a wrong-region endpoint or an
 * unreachable host still produces a run that completes, because the tracer
 * reports a rejected send as a warning rather than failing the run it traced.
 */
export function resolveTracingConfig(
  env: Readonly<Record<string, string | undefined>>,
): TracingConfig {
  // Own reads, and this is the one surface of the eight on a production path:
  // `apps/cli` passes `process.env`, whose prototype chain reaches
  // `Object.prototype`. A plain `[[Get]]` here let a polluted prototype turn
  // tracing ON and choose the project, from an env object owning nothing —
  // pointing a real run's traces at somebody else's project.
  //
  // ⚠ What it does NOT close: the SDK reads the api key from the environment
  // itself, with its own `[[Get]]`, so the key half of that hazard lives in
  // `langsmith/dist/utils/env.js` and not here. This function returns no key by
  // design, which is why the reasoning above stops at the project.
  if (!TRACING_FLAG_VARIABLES.some((name) => ownValue(env, name) === 'true')) {
    return { enabled: false };
  }

  const apiKey =
    ownString(env, 'LANGSMITH_API_KEY') ?? ownString(env, 'LANGCHAIN_API_KEY');
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      'tracing is enabled but no api key is set: export LANGSMITH_API_KEY (or LANGCHAIN_API_KEY)',
    );
  }

  return {
    enabled: true,
    project:
      ownString(env, 'LANGSMITH_PROJECT') ??
      ownString(env, 'LANGCHAIN_PROJECT') ??
      'default',
  };
}
