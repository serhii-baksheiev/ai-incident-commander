import {
  DOMAIN_LAYER,
  EXPECTED_OBSERVATION_VERSION,
  normalizeSubject,
  type Evidence,
  type InvestigationRouteEntry,
  type InvestigationRouteTable,
  type ObservedFact,
} from '@aic/domain';

import type { BoundSourceBinding, BoundSourceRegistry } from '../src/bound-source-registry.js';
import {
  buildReplayIdentity,
  createBoundSourceRegistry,
  createMemoryReplayStore,
} from '../src/bound-source-registry.js';
import {
  isReadOnlyToolId,
  isToolResult,
  READ_ONLY_TOOL_REGISTRY,
  type ToolResult,
} from '../src/contracts.js';
import { createIncidentToolSource } from '../src/incident-tool-source.js';
import {
  createReplayFixtureKey,
  REPLAY_FIXTURE_VERSION,
} from '../src/replay-key.js';
import { migrateReplayFixtureV1 } from '../src/replay-migration.js';

export const REPLAY_TOOL_DEPENDENCIES = [DOMAIN_LAYER] as const;
export { REPLAY_FIXTURE_VERSION };

export interface ReplayFixture<Output = Evidence[]> {
  readonly version: typeof REPLAY_FIXTURE_VERSION;
  readonly responses: Readonly<Record<string, ToolResult<Output>>>;
}

const MIGRATION_FETCHED_AT = '1970-01-01T00:00:00.000Z';

/**
 * AIC-123 slice 3b: the optional second constructor argument that merges
 * `Evidence.observation` onto a replayed `ok` array output, without altering
 * anything about a plain `new ReplayToolAdapter(fixture)`. See
 * observation-merge.test.mjs › "ReplayToolAdapter without a second
 * constructor argument replays deployment-caused-incident-a byte-identical
 * to its fixture, with no observation key on any evidence item, even though
 * OBSERVATION_ANNOTATIONS carries facts for it".
 */
export interface ReplayToolAdapterOptions {
  /**
   * Consulted once per evidence item in an `ok` array output, keyed by the
   * call's own v2 replay identity (`buildReplayIdentity`, never re-derived
   * here) and the item itself. A non-empty list merges as
   * `observation: { version: EXPECTED_OBSERVATION_VERSION, facts }`; an
   * empty or `undefined` answer leaves the item unchanged. See
   * observation-merge.test.mjs › "ReplayToolAdapter given { observations }
   * merges facts only onto the item the annotator returns a non-empty list
   * for, as a new object equal to the item plus observation:{version,facts},
   * leaves the other item untouched, and never mutates the caller's own
   * fixture object".
   */
  readonly observations?: (
    identity: string,
    evidence: Evidence,
  ) => readonly ObservedFact[] | undefined;
}

/**
 * AIC-100, slice d: a wrapper over `createBoundSourceRegistry`'s `replay` mode,
 * over the v1 fixture migrated once by `migrateReplayFixtureV1`. The stub
 * sources only give each read-only tool id a binding. `createReplayFixtureKey`
 * runs first to keep the legacy key-failure result
 * (test/tool-registry-replay.test.mjs › "redacts replay key generation errors
 * from ToolResult.error").
 */
export class ReplayToolAdapter<Output = Evidence[]> {
  readonly #registry: BoundSourceRegistry;
  readonly #observations: ReplayToolAdapterOptions['observations'];

  constructor(fixture: ReplayFixture<Output>, options?: ReplayToolAdapterOptions) {
    if (fixture.version !== REPLAY_FIXTURE_VERSION) {
      throw new Error(`unsupported replay fixture version: ${fixture.version}`);
    }

    this.#observations = options?.observations;

    const { recordings } = migrateReplayFixtureV1(fixture, { fetchedAt: MIGRATION_FETCHED_AT });

    const bindings: BoundSourceBinding[] = READ_ONLY_TOOL_REGISTRY.map(({ id }) => ({
      sourceBindingId: id,
      source: createIncidentToolSource({
        id,
        risk: 'read' as const,
        async execute(): Promise<ToolResult<Output>> {
          throw new Error(
            `ReplayToolAdapter: source.execute must never be called in replay mode (tool ${id})`,
          );
        },
      }),
      credentialRefId: null,
    }));

    this.#registry = createBoundSourceRegistry({
      mode: 'replay',
      bindings,
      store: createMemoryReplayStore(recordings),
      clock: () => new Date(MIGRATION_FETCHED_AT),
    });
  }

  async execute(toolId: string, input: unknown): Promise<ToolResult<Output>> {
    if (!isReadOnlyToolId(toolId)) {
      return { status: 'unavailable', reason: `tool is not registered: ${toolId}` };
    }

    try {
      createReplayFixtureKey(toolId, input);
    } catch {
      return {
        status: 'error',
        message: 'replay key generation failed',
      };
    }

    const outcome = await this.#registry.execute(toolId, toolId, input);

    if (outcome.status === 'ok' && isToolResult<Output>(outcome.output)) {
      const result = outcome.output;
      if (this.#observations && result.status === 'ok' && Array.isArray(result.output)) {
        const annotate = this.#observations;
        const identity = buildReplayIdentity({
          sourceBindingId: outcome.provenance.sourceBindingId,
          adapter: outcome.provenance.adapter,
          requestFingerprint: outcome.provenance.requestFingerprint,
        });
        const annotatedOutput = (result.output as readonly Evidence[]).map((item) => {
          const facts = annotate(identity, item);
          if (!facts || facts.length === 0) return item;
          return { ...item, observation: { version: EXPECTED_OBSERVATION_VERSION, facts: [...facts] } };
        });
        return { ...result, output: annotatedOutput as Output };
      }
      return result;
    }

    return {
      status: 'unavailable',
      reason: 'replay response is not recorded',
    };
  }
}

/**
 * AIC-125 slice c: the scenario replay fixture shape a scenario module (e.g.
 * `packages/evals/src/replay-scenarios.ts`'s `ScenarioReplayFixture`) carries
 * — never imported as a type here, since `@aic/tools` must not import
 * `@aic/evals` types (test/replay-scenarios.test.mjs › "keeps @aic/evals
 * independent of @aic/tools"). Structurally identical to it on purpose, so a
 * caller passes its own fixture through unchanged.
 */
export interface PlannedReplayScenarioEntry {
  readonly toolId: string;
  readonly input: unknown;
  readonly result: ToolResult<Evidence[]>;
}

export interface PlannedReplayScenarioFixture {
  readonly version: number;
  readonly entries: readonly PlannedReplayScenarioEntry[];
}

/**
 * The minimal `PlannedReplayScenarioFixture` -> `ReplayToolAdapter` fixture
 * (`{ version: REPLAY_FIXTURE_VERSION, responses }`, keyed by
 * `createReplayFixtureKey`) conversion. `test/fixtures/benchmark-experiment.mjs`
 * carried this same conversion as its own `replayFixtureFor` before this
 * slice (`git show origin/main:test/fixtures/benchmark-experiment.mjs`); it
 * now imports this export instead of a second copy
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation") — see
 * planned-replay.test.mjs › "replayFixtureFromScenarioEntries converts a
 * calibration scenario's replay fixture into exactly the ReplayToolAdapter
 * fixture test/fixtures/benchmark-experiment.mjs's own replayFixtureFor
 * produced for it before this slice (git show
 * origin/main:test/fixtures/benchmark-experiment.mjs)" and › "a
 * ReplayToolAdapter built from replayFixtureFromScenarioEntries replays a
 * recorded entry byte-identical to the scenario's own recorded result".
 */
export function replayFixtureFromScenarioEntries(
  fixture: PlannedReplayScenarioFixture,
): ReplayFixture {
  return {
    version: REPLAY_FIXTURE_VERSION,
    responses: Object.fromEntries(
      fixture.entries.map((entry) => [createReplayFixtureKey(entry.toolId, entry.input), entry.result]),
    ),
  };
}

export interface PlannedReplayContext {
  readonly runId: string;
  readonly testId: string;
  readonly attempt: number;
  readonly tool: string;
  readonly input: unknown;
}

export interface CreatePlannedReplayExecutorOptions {
  readonly fixture: PlannedReplayScenarioFixture;
  readonly routes: InvestigationRouteTable;
  /**
   * REQUIRED: a tool port cannot default to `@aic/evals`'s own observation
   * annotator (`@aic/tools` must not import `@aic/evals`), so every caller
   * passes one explicitly — see planned-replay.test.mjs › "constructing
   * without annotate throws a TypeError naming annotate: a tool port cannot
   * default to evals' own observation annotator".
   */
  readonly annotate: NonNullable<ReplayToolAdapterOptions['observations']>;
}

export interface PlannedReplayExecutor {
  execute(context: PlannedReplayContext): Promise<ToolResult<Evidence[]>>;
}

function isPlainRequestInput(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function findRouteForTool(
  routes: InvestigationRouteTable,
  tool: string,
): { readonly form: string; readonly route: InvestigationRouteEntry } | undefined {
  for (const [form, route] of Object.entries(routes.byForm)) {
    if (route.tool === tool) return { form, route };
  }
  return undefined;
}

function keysMatchExactly(routeInput: Readonly<Record<string, string>>, input: Record<string, unknown>): boolean {
  const routeKeys = Object.keys(routeInput);
  const inputKeys = Object.keys(input);
  if (routeKeys.length !== inputKeys.length) return false;
  return routeKeys.every((key) => Object.hasOwn(input, key));
}

interface RequestedQuantity {
  readonly form: string;
  readonly subject: string;
  readonly window: string;
  readonly discriminants: ReadonlyArray<readonly [string, unknown]>;
}

function requestedQuantity(
  form: string,
  route: InvestigationRouteEntry,
  input: Record<string, unknown>,
): RequestedQuantity | undefined {
  const observationFields: Record<string, unknown> = {};
  for (const [requestField, observationField] of Object.entries(route.input)) {
    observationFields[observationField] = input[requestField];
  }
  const { subject, window, ...discriminantFields } = observationFields;
  if (typeof subject !== 'string' || typeof window !== 'string') return undefined;
  return { form, subject, window, discriminants: Object.entries(discriminantFields) };
}

function factMatchesQuantity(fact: ObservedFact, quantity: RequestedQuantity): boolean {
  if (fact.form !== quantity.form) return false;
  if (normalizeSubject(fact.subject) !== normalizeSubject(quantity.subject)) return false;
  if (fact.window !== quantity.window) return false;
  const factRecord = fact as unknown as Record<string, unknown>;
  return quantity.discriminants.every(([field, value]) => factRecord[field] === value);
}

/**
 * AIC-125 slice c: the replay port a planned (`plan_investigation`, slice a)
 * request answers through when the frozen corpus records no call whose OWN
 * input equals the request. A vocabulary request such as `{ service:
 * 'payments', window: 'pre-onset' }` (`routes`, `@aic/graph`'s
 * `INVESTIGATION_ROUTES`) names a quantity the corpus never queried directly,
 * but a recorded call for a DIFFERENT window on the same tool may still
 * carry, in its own `OBSERVATION_ANNOTATIONS` fact, the answer to exactly
 * that quantity. This port is the read side of that gap; it is not wired
 * into any lane here. See planned-replay.test.mjs, this function's whole
 * spec.
 *
 * Two lookups, tried in order:
 *
 * 1. **Exact.** The request's own replay identity — `createReplayFixtureKey`,
 *    the one place that canonicalisation lives — matches a fixture entry.
 *    The request is then answered by literally replaying that entry through
 *    the internal `ReplayToolAdapter` (built once, with
 *    `{ observations: annotate }`), so this port never re-implements what
 *    that adapter already does. Key order in the request's own input never
 *    matters, because `createReplayFixtureKey` canonicalises before
 *    comparing — see planned-replay.test.mjs › "an EXACT recorded request
 *    answers exactly what ReplayToolAdapter with the observation annotator
 *    returns for it, evidence carrying observation where the table has
 *    facts" and › "an EXACT recorded request matches by replay identity, not
 *    object key order: the same input with its keys reordered still counts
 *    as the exact recorded request".
 * 2. **Quantity.** No exact match. `routes` is inverted: the one route entry
 *    whose `tool` equals the request's tool, and whose `input` mapping's
 *    keys are exactly the request input's own keys (a non-object input, or a
 *    key set that is not an exact match, is never routed) gives back the
 *    requested quantity — `form` (the route's own key in `routes.byForm`),
 *    `subject`, `window`, and the form's own discriminant (`signal` or
 *    `logClass`; `deployment-in-window` carries none). Every recorded entry
 *    of the SAME tool is then replayed through the adapter, and every
 *    evidence item whose annotated fact matches that quantity — same form,
 *    `normalizeSubject(subject)` (`@aic/domain`'s own rule, imported rather
 *    than re-implemented here), `window`, and discriminant — is answered,
 *    each evidence id once, in fixture order. A recorded entry of a
 *    DIFFERENT tool is never even inspected — see planned-replay.test.mjs ›
 *    "a QUANTITY match answers ok with the union of every same-tool recorded
 *    entry whose annotated fact matches the requested form, subject, window
 *    and discriminant, each evidence id once, in fixture order", › "a
 *    QUANTITY match never inspects a recorded entry of a different tool: an
 *    entry of an unrelated tool is neither annotated nor returned, even when
 *    its own fact would otherwise match" and › "unrelated entries are never
 *    executed: a fixture carrying entries no request names is replayed for
 *    none of them, only the matched entry is replayed".
 *
 * The match is on the QUANTITY a fact measures, never on the value it
 * reports — a `state: 'normal'` fact matches a request for `signal-state` on
 * `error-rate` exactly as a `state: 'elevated'` one would. This is not an
 * outcome oracle: it answers "was this quantity measured", never "does the
 * measurement favour a hypothesis" — see planned-replay.test.mjs › "a
 * QUANTITY match is independent of outcome: a matching fact that contradicts
 * what a hopeful template expected still answers ok with that fact" and › "a
 * QUANTITY match compares the subject case- and whitespace-insensitively,
 * matching normalizeSubject's own rule (trim + lowercase)".
 *
 * No match at all — an unrouted tool, a malformed or short/over-specified
 * input, a routed request with no same-tool recording, or same-tool
 * recordings that carry no matching fact — answers `{ status: 'unavailable',
 * reason }`, never `ok` with an empty array: absence of a measurement is not
 * negative evidence — see planned-replay.test.mjs's "answers unavailable,
 * never ok" / "never ok-with-empty" rows. The port never throws for any
 * input, well-formed or not — see planned-replay.test.mjs's "answers
 * unavailable and the port does not throw" rows and › "the port never throws
 * for a well-formed but unroutable request".
 */
export function createPlannedReplayExecutor(
  options: CreatePlannedReplayExecutorOptions,
): PlannedReplayExecutor {
  const { fixture, routes, annotate } = options;
  if (typeof annotate !== 'function') {
    throw new TypeError('createPlannedReplayExecutor: options.annotate is required and must be a function');
  }

  const adapter = new ReplayToolAdapter(replayFixtureFromScenarioEntries(fixture), { observations: annotate });
  const exactKeys = new Set(fixture.entries.map((entry) => createReplayFixtureKey(entry.toolId, entry.input)));

  async function execute(context: PlannedReplayContext): Promise<ToolResult<Evidence[]>> {
    const { tool, input } = context;

    let exactKey: string | undefined;
    try {
      exactKey = createReplayFixtureKey(tool, input);
    } catch {
      exactKey = undefined;
    }
    if (exactKey !== undefined && exactKeys.has(exactKey)) {
      return adapter.execute(tool, input);
    }

    if (!isPlainRequestInput(input)) {
      return {
        status: 'unavailable',
        reason: `planned replay: request input for tool ${JSON.stringify(tool)} is not an object`,
      };
    }

    const routed = findRouteForTool(routes, tool);
    if (!routed) {
      return {
        status: 'unavailable',
        reason: `planned replay: no route in routes.byForm names tool ${JSON.stringify(tool)}`,
      };
    }
    const { form, route } = routed;

    if (!keysMatchExactly(route.input, input)) {
      return {
        status: 'unavailable',
        reason: `planned replay: input keys do not exactly match the routed form ${JSON.stringify(form)}`,
      };
    }

    const quantity = requestedQuantity(form, route, input);
    if (!quantity) {
      return {
        status: 'unavailable',
        reason: `planned replay: request input for form ${JSON.stringify(form)} is missing a required field`,
      };
    }

    const matched: Evidence[] = [];
    const seenEvidenceIds = new Set<string>();
    for (const entry of fixture.entries) {
      if (entry.toolId !== tool) continue;
      if (entry.result.status !== 'ok') continue;

      const replayed = await adapter.execute(entry.toolId, entry.input);
      if (replayed.status !== 'ok') continue;

      for (const item of replayed.output) {
        const facts = item.observation?.facts ?? [];
        if (!facts.some((fact) => factMatchesQuantity(fact, quantity))) continue;
        if (seenEvidenceIds.has(item.id)) continue;
        seenEvidenceIds.add(item.id);
        matched.push(item);
      }
    }

    if (matched.length === 0) {
      return {
        status: 'unavailable',
        reason: `planned replay: no recorded entry of tool ${JSON.stringify(tool)} carries a fact matching the requested quantity`,
      };
    }

    return { status: 'ok', output: matched };
  }

  return { execute };
}
