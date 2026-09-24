import { DOMAIN_LAYER, type Evidence } from '@aic/domain';

import type { BoundSourceBinding, BoundSourceRegistry } from '../src/bound-source-registry.js';
import { createBoundSourceRegistry, createMemoryReplayStore } from '../src/bound-source-registry.js';
import {
  isReadOnlyToolId,
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

/**
 * Fixed and never observed: `migrateReplayFixtureV1` requires a `fetchedAt`,
 * and the registry's own `replay` mode requires a `clock`, but `execute()`
 * below unwraps a registry hit down to the stored `ToolResult`'s own
 * `output`/`reason`/`message`, discarding every `EvidenceSourceOutcome`
 * `provenance` field (`fetchedAt` included) this migration/registry pair
 * builds along the way.
 */
const MIGRATION_FETCHED_AT = '1970-01-01T00:00:00.000Z';

/**
 * AIC-100, slice d: `ReplayToolAdapter` becomes a thin wrapper over
 * `createBoundSourceRegistry`'s `replay` mode. The legacy v1 fixture is
 * migrated ONCE, at construction, via `migrateReplayFixtureV1`
 * (`../src/replay-migration.ts`) into the v2 recordings shape the registry
 * reads; every one of `READ_ONLY_TOOL_REGISTRY`'s six tool ids is bound
 * through `createIncidentToolSource` (`../src/incident-tool-source.ts`)
 * wrapping a stub tool whose own `execute()` always throws — replay mode
 * never calls a binding's `source.execute()` at all, so that stub is never
 * reached; it exists only to give the registry a valid
 * `describe().adapterId`/`.version`/`.operations` to bind against.
 *
 * Every existing public signature and error string is kept exactly:
 * `unsupported replay fixture version: …` on construction,
 * `` `tool is not registered: ${toolId}` `` for a tool id outside the closed
 * read-only registry, `replay key generation failed` for an input
 * `createReplayFixtureKey` itself refuses (a circular object, a value
 * `canonicalJson` refuses, a getter that throws — this class still calls
 * `createReplayFixtureKey` itself for exactly this validation, BEFORE ever
 * consulting the registry, so the same failure surface fails the same way it
 * always did), and `replay response is not recorded` for a miss. A stored hit
 * is always the registry's `ok` outcome — `migrateReplayFixtureV1` carries
 * every legacy `ToolResult` (`ok`, `unavailable` or `error`) WHOLE as an `ok`
 * recording — so unwrapping `outcome.output` on any hit reproduces the exact
 * original `ToolResult` variant, redacted by the registry's own
 * `redactEvidenceOutput` pass on the way out. See
 * test/tool-registry-replay.test.mjs's and
 * test/legacy-adapters-on-registry.test.mjs's unmodified rows for both.
 */
export class ReplayToolAdapter<Output = Evidence[]> {
  readonly #registry: BoundSourceRegistry;

  constructor(fixture: ReplayFixture<Output>) {
    if (fixture.version !== REPLAY_FIXTURE_VERSION) {
      throw new Error(`unsupported replay fixture version: ${fixture.version}`);
    }

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

    if (outcome.status === 'ok') {
      return outcome.output as ToolResult<Output>;
    }

    return {
      status: 'unavailable',
      reason: 'replay response is not recorded',
    };
  }
}
