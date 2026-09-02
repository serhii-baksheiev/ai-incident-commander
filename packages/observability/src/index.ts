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
const PERSISTED_RESOURCE_SCHEMA_VERSION = 1;
const PERSISTED_RESOURCE_KEYS = [
  'logicalIterationsUsed',
  'declaredLlmCallsUsed',
  'toolCallsUsed',
  'wallClockDurationMs',
  'retryCount',
  'resumeCount',
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
  'temperature',
] as const satisfies readonly (keyof PersistedBenchmarkRunMetadata)[];

const PERSISTED_OPTIONAL_METADATA_KEYS = [
  'evaluatorVersion',
  'seed',
  'docsAvailable',
] as const satisfies readonly (keyof PersistedBenchmarkRunMetadata)[];

const PERSISTED_BEHAVIOR_EVALUATOR_VERSION =
  'behavior-evaluators-v0.2' as const;

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
  readonly temperature: number;
  readonly seed?: number;
  readonly docsAvailable?: boolean;
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
    Record<string, Readonly<{ key: string; score: number }>>
  >;
  readonly resources?: Readonly<Record<string, unknown>>;
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
}

export interface PersistedBenchmarkExperiment {
  readonly records: readonly PersistedBenchmarkRecord[];
  readonly results: readonly PersistedBenchmarkEvaluation[];
}

export function createLangSmithClient(): LangSmithPersistenceClient {
  return new Client({ omitTracedRuntimeInfo: true });
}

function assertResultIdentity(
  record: PersistedBenchmarkRecord,
  result: PersistedBenchmarkEvaluation,
): void {
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
 * 🔴 That is a claim about this function, not about the layer, and the
 * difference is measured rather than assumed. EIGHT surfaces carrying INBOUND
 * run data still walk the prototype chain here — some of them more than one
 * field — enumerated because a partial list reads as a complete one, and this
 * header is what a later reader will trust. Two earlier drafts of this very
 * paragraph were subsets, which is why the count is stated and the omission it
 * hid is now first:
 *
 *   1. `experiment.records` / `experiment.results` — the containers
 *      `requireExperiment` and the persist loop are handed, and the largest of
 *      the eight: an experiment owning NEITHER field publishes an inherited run
 *      whole — examples, project, run and every feedback score;
 *   2. `result.resources` — the CONTAINER `requireResourceEvidence` validates
 *      field by field. An accessor of that name is invoked and its six axes
 *      reach `outputs.resources` AND the per-axis feedback keys;
 *   3. `record.metadata` — the container `projectRunMetadata` is handed, so a
 *      record owning no metadata publishes an inherited 11-field block;
 *   4. `record.runId` / `exampleId` / `experimentId` — `assertResultIdentity`
 *      compares two `[[Get]]`s, so when BOTH sides are absent they read the
 *      same inherited value and the identity check passes. The comparison is
 *      not where it ends: those same values are PUBLISHED, as `createRun.id`,
 *      `project_name`, `reference_example_id` and every feedback `runId`;
 *   5. `record.scenario` and its `id` / `groundTruth` — reaching
 *      `createExamples`, where `groundTruth` is published verbatim;
 *   6. `record.metadata.scenarioId` — becoming the run's name and
 *      `inputs.scenarioId`;
 *   7. `record.threadId` — becoming `inputs.threadId`;
 *   8. `result.actualStopKind` — becoming `outputs.actualStopKind`.
 *
 * ⚠ That count is over inbound RUN DATA, and two other kinds of read in this
 * file walk the chain without being in it. Values the SDK hands back —
 * `dataset.id` and `project.id`, the latter becoming every feedback
 * `sessionId` — come from the client rather than from a record. The tracing
 * config reads its variables off the injected `env` object the same way. Both
 * are excluded on the same ground: the eight are what a CALLER supplies.
 *
 * All eight are pre-existing, and that is checkable from the diff rather than
 * asserted: this change touches none of those reads. They are outside what
 * AIC-67 was scoped to and are filed as a triage proposal rather than fixed
 * here; until one lands, nothing in this header entitles a reader to conclude
 * that no published value came from a getter.
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
 * The write half of the same hazard, and it is a separate function because
 * refusing to READ a polluted value is only half the job.
 *
 * `target[key] = value` is an ordinary `[[Set]]`: it walks the prototype chain,
 * and an inherited ACCESSOR named like the field swallows the write — the
 * setter runs, no own property is created, and the field vanishes from the
 * published record. CreateDataProperty semantics cannot be intercepted by the
 * prototype chain — the qualifier is load-bearing, since a `Proxy` traps
 * `defineProperty` and a frozen target throws. Both call sites pass a freshly
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

function projectRunMetadata(
  metadata: PersistedBenchmarkRunMetadata,
): Record<string, unknown> {
  const declaredEvaluatorVersion = ownValue(metadata, 'evaluatorVersion');
  if (
    declaredEvaluatorVersion !== undefined &&
    declaredEvaluatorVersion !== PERSISTED_BEHAVIOR_EVALUATOR_VERSION
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
  Readonly<{ key: string; score: number }>
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
      if (typeof ownValue(metric, 'score') !== 'number') {
        throw new Error(`benchmark result metric has no score of its own: ${key}`);
      }
      return [key, metric];
    }),
  ) as Record<
    (typeof PERSISTED_METRIC_KEYS)[number],
    Readonly<{ key: string; score: number }>
  >;
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
  if (result.resources === undefined) return undefined;

  const evidence = result.resources;
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
  for (const key of PERSISTED_RESOURCE_KEYS) {
    const value = own(key);
    if (value === undefined) {
      throw new Error(`benchmark resource evidence missing ${key}`);
    }
    // The same rule the graph applies to its own counters: a count is a
    // non-negative safe integer. Restated rather than imported because this
    // layer keeps its own outbound vocabulary — but it must not be LOOSER than
    // the graph's, or a negative duration crosses the boundary as evidence.
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`benchmark resource evidence ${key} is not a count`);
    }
    entries.push([key, value]);
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
    if (
      evaluatorVersion !== PERSISTED_BEHAVIOR_EVALUATOR_VERSION ||
      metricEvaluatorVersion !== PERSISTED_BEHAVIOR_EVALUATOR_VERSION
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
  records: readonly PersistedBenchmarkRecord[],
): NativeExampleCreate[] {
  const runNumbers = new Map<string, number>();
  return records.map((record) => {
    const runNumber = (runNumbers.get(record.scenario.id) ?? 0) + 1;
    runNumbers.set(record.scenario.id, runNumber);
    return {
      id: record.exampleId,
      dataset_id: datasetId,
      inputs: { scenarioId: record.scenario.id, runNumber },
      outputs: { groundTruth: record.scenario.groundTruth },
    };
  });
}

function requireExperiment(
  experiment: PersistedBenchmarkExperiment,
): PersistedBenchmarkRecord {
  if (experiment.records.length !== experiment.results.length) {
    throw new Error('benchmark records and results must have the same length');
  }
  const firstRecord = experiment.records[0];
  if (firstRecord === undefined) {
    throw new Error('benchmark experiment must contain at least one record');
  }
  if (
    experiment.records.some(
      ({ experimentId }) => experimentId !== firstRecord.experimentId,
    )
  ) {
    throw new Error('benchmark records must belong to one experiment');
  }
  return firstRecord;
}

async function persistPreparedExperiment({
  client,
  datasetId,
  experiment,
}: Readonly<{
  client: LangSmithPersistenceClient;
  datasetId: string;
  experiment: PersistedBenchmarkExperiment;
}>): Promise<void> {
  const firstRecord = requireExperiment(experiment);
  const project = await client.createProject({
    projectName: firstRecord.experimentId,
    referenceDatasetId: datasetId,
  });

  for (const [index, record] of experiment.records.entries()) {
    const result = experiment.results[index];
    if (result === undefined) {
      throw new Error('benchmark result is missing for its run record');
    }
    assertResultIdentity(record, result);
    const metrics = requireMetrics(result);
    const resources = requireResourceEvidence(result);
    // Own-read, the same way `projectRunMetadata` reads this field further down
    // this function. This is the pairing input that decides whether the run measured
    // behaviour at all, so a `[[Get]]` here let an inherited version admit
    // versioned metrics while the published metadata declared none — the record
    // shape this whole change exists to make impossible. A non-string reads as
    // absent rather than being cast: the paired-declaration guard then refuses,
    // which is the honest answer to metrics whose version nobody stated.
    const declaredEvaluatorVersion = ownValue(record.metadata, 'evaluatorVersion');
    const behaviorMetrics = requireBehaviorMetrics(
      result,
      typeof declaredEvaluatorVersion === 'string'
        ? declaredEvaluatorVersion
        : undefined,
    );

    await client.createRun({
      id: record.runId,
      name: `benchmark:${record.metadata.scenarioId}`,
      run_type: 'chain',
      project_name: record.experimentId,
      inputs: {
        exampleId: record.exampleId,
        scenarioId: record.metadata.scenarioId,
        threadId: record.threadId,
      },
      outputs: {
        actualStopKind: result.actualStopKind,
        metrics,
        behaviorMetrics,
        // One key per dimension, never merged into a score, and absent when the
        // run was not measured.
        ...(resources === undefined ? {} : { resources }),
      },
      extra: { metadata: projectRunMetadata(record.metadata) },
      reference_example_id: record.exampleId,
    });

    for (const metric of [
      ...Object.values(metrics),
      ...Object.values(behaviorMetrics),
    ]) {
      await client.createFeedback({
        runId: record.runId,
        sessionId: project.id,
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
    if (resources !== undefined) {
      for (const key of PERSISTED_RESOURCE_KEYS) {
        await client.createFeedback({
          runId: record.runId,
          sessionId: project.id,
          key,
          score: resources[key],
        });
      }
    }
  }
}

export async function persistBenchmarkExperiments({
  client = createLangSmithClient(),
  datasetName,
  experiments,
}: Readonly<{
  client?: LangSmithPersistenceClient;
  datasetName: string;
  experiments: readonly PersistedBenchmarkExperiment[];
}>): Promise<void> {
  if (datasetName.length === 0) {
    throw new Error('datasetName must not be empty');
  }
  const firstExperiment = experiments[0];
  if (firstExperiment === undefined) {
    throw new Error('at least one benchmark experiment is required');
  }
  requireExperiment(firstExperiment);

  const nativeExampleIds = new Set(
    firstExperiment.records.map(({ exampleId }) => exampleId),
  );
  for (const experiment of experiments.slice(1)) {
    requireExperiment(experiment);
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
  await client.createExamples(
    createNativeExamples(dataset.id, firstExperiment.records),
  );
  for (const experiment of experiments) {
    await persistPreparedExperiment({
      client,
      datasetId: dataset.id,
      experiment,
    });
  }
}

export async function persistBenchmarkExperiment({
  client = createLangSmithClient(),
  datasetName,
  experiment,
}: Readonly<{
  client?: LangSmithPersistenceClient;
  datasetName: string;
  experiment: PersistedBenchmarkExperiment;
}>): Promise<void> {
  await persistBenchmarkExperiments({
    client,
    datasetName,
    experiments: [experiment],
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
  if (!TRACING_FLAG_VARIABLES.some((name) => env[name] === 'true')) {
    return { enabled: false };
  }

  const apiKey = env.LANGSMITH_API_KEY ?? env.LANGCHAIN_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      'tracing is enabled but no api key is set: export LANGSMITH_API_KEY (or LANGCHAIN_API_KEY)',
    );
  }

  return {
    enabled: true,
    project: env.LANGSMITH_PROJECT ?? env.LANGCHAIN_PROJECT ?? 'default',
  };
}
