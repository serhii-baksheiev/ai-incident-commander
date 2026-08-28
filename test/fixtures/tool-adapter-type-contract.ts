import type { Evidence } from '@aic/domain';
import type { ToolResult } from '@aic/tools';
import { LiveToolAdapter } from '@aic/tools/live';
import {
  ReplayToolAdapter,
  REPLAY_FIXTURE_VERSION,
} from '@aic/tools/replay';

const liveAdapter = new LiveToolAdapter([]);
const replayAdapter = new ReplayToolAdapter({
  version: REPLAY_FIXTURE_VERSION,
  responses: {},
});

const liveResult: Promise<ToolResult<Evidence[]>> = liveAdapter.execute('logs', {});
const replayResult: Promise<ToolResult<Evidence[]>> = replayAdapter.execute('logs', {});

void liveResult;
void replayResult;
