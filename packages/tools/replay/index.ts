import { DOMAIN_LAYER, type Evidence } from '@aic/domain';

import type { BoundSourceBinding, BoundSourceRegistry } from '../src/bound-source-registry.js';
import { createBoundSourceRegistry, createMemoryReplayStore } from '../src/bound-source-registry.js';
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

/** Provenance is discarded on unwrap, so this timestamp is never returned. */
const MIGRATION_FETCHED_AT = '1970-01-01T00:00:00.000Z';

/**
 * AIC-100, slice d: a thin wrapper over `createBoundSourceRegistry`'s `replay`
 * mode. The v1 fixture is migrated once, at construction, by
 * `migrateReplayFixtureV1`; each read-only tool id is bound to a stub source
 * that replay mode never executes. `createReplayFixtureKey` still runs first,
 * so an input it refuses keeps its legacy error. The public signature and
 * error strings are unchanged (test/tool-registry-replay.test.mjs).
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

    if (outcome.status === 'ok' && isToolResult<Output>(outcome.output)) {
      return outcome.output;
    }

    return {
      status: 'unavailable',
      reason: 'replay response is not recorded',
    };
  }
}
