import { DOMAIN_LAYER, type Evidence } from '@aic/domain';

import {
  isReadOnlyToolId,
  type ToolResult,
} from '../src/contracts.js';
import {
  createReplayFixtureKey,
  REPLAY_FIXTURE_VERSION,
} from '../src/replay-key.js';

export const REPLAY_TOOL_DEPENDENCIES = [DOMAIN_LAYER] as const;
export { REPLAY_FIXTURE_VERSION };

export interface ReplayFixture<Output = Evidence[]> {
  readonly version: typeof REPLAY_FIXTURE_VERSION;
  readonly responses: Readonly<Record<string, ToolResult<Output>>>;
}

export class ReplayToolAdapter<Output = Evidence[]> {
  readonly #fixture: ReplayFixture<Output>;

  constructor(fixture: ReplayFixture<Output>) {
    if (fixture.version !== REPLAY_FIXTURE_VERSION) {
      throw new Error(`unsupported replay fixture version: ${fixture.version}`);
    }
    this.#fixture = fixture;
  }

  async execute(toolId: string, input: unknown): Promise<ToolResult<Output>> {
    if (!isReadOnlyToolId(toolId)) {
      return { status: 'unavailable', reason: `tool is not registered: ${toolId}` };
    }

    try {
      const key = createReplayFixtureKey(toolId, input);
      return (
        this.#fixture.responses[key] ?? {
          status: 'unavailable',
          reason: 'replay response is not recorded',
        }
      );
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'replay key generation failed',
      };
    }
  }
}
