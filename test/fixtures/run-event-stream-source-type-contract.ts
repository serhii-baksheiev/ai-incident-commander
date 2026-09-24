/**
 * AIC-58, slice a: the compile-time half of the domain's `RunEventStreamSource`
 * port contract — `RunEvent`'s shape and `RunEventStreamSource`'s two methods
 * (`readAfter`, `tail`), pinned the same way `durable-tool-replay-type-contract.ts`
 * pins `CommittedExecution`: a real object literal typed against the port,
 * checked for structural acceptance, and one row proving the check is not
 * vacuous (an object missing `tail` is refused).
 *
 * Deliberately domain-only: this file names nothing from `@aic/persistence`.
 * `infra/postgres/tests/run-event-stream.live.mjs` is where a REAL
 * `createRunEventStreamSource(pool)` is driven at runtime and so (indirectly)
 * proven to satisfy this same shape — see that file's own header.
 *
 * A real value, not a `declare`: like `durable-tool-replay-type-contract.ts`,
 * `test/fixtures` is swept by node's default test-file discovery, so this file
 * is also EXECUTED with its types stripped — every binding below must be
 * valid plain JavaScript too.
 */
import type { RunEvent, RunEventStreamSource } from '@aic/domain';

function acceptsRunEventStreamSource(source: RunEventStreamSource): void {
  void source;
}

const fakeEvent: RunEvent = {
  runId: 'run-fixture',
  seq: 1,
  type: 'node_result.committed',
  executionAttempt: 1,
  payload: { ok: true },
  createdAt: new Date(),
};

async function* fakeTail(): AsyncGenerator<RunEvent, void, void> {
  yield fakeEvent;
}

const fakeSource: RunEventStreamSource = {
  readAfter: async (_runId, _afterSeq, _options) => [fakeEvent],
  tail: (_runId, _options) => fakeTail(),
};

acceptsRunEventStreamSource(fakeSource);

// Not vacuous: an object missing `tail` is refused, or the check above would
// prove nothing about the shape and everything would pass regardless.
const notASource = { readAfter: fakeSource.readAfter };
// @ts-expect-error RunEventStreamSource requires a tail method
acceptsRunEventStreamSource(notASource);

void notASource;
