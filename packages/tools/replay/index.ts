import { DOMAIN_LAYER, EXPECTED_OBSERVATION_VERSION, type Evidence, type ObservedFact } from '@aic/domain';

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
