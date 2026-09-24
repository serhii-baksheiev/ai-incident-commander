import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';

/** The config type the saver methods take, from the base class itself. */
type RunnableConfig = Parameters<BaseCheckpointSaver['getTuple']>[0];

/** What the fenced checkpointer needs from a run write context. */
export interface CheckpointFence {
  assertOwner(kind?: string): Promise<void>;
}

export interface FencedCheckpointerOptions {
  /**
   * Runs after the fence passed and before the inner saver writes — the seam
   * AIC-57's race harness holds open to reorder a stale write against a new
   * owner's. see fenced-checkpointer.live.mjs › "the barrier seam: beforeWrite
   * holds a passing write open, and no checkpoint lands until it is released"
   */
  readonly beforeWrite?: () => Promise<void>;
}

/**
 * The fenced checkpointer of docs/decisions/durable-run-execution.md, decision
 * 9: checkpoint writes pass the same ownership fence as product commits, and a
 * refused write never reaches the inner saver. Reads are not fenced.
 *
 * The fence check and the inner saver's write are separate statements on
 * separate connections, so a lease can be lost between them; that window is
 * what AIC-57 measures, and why the decision is Proposed until it does.
 *
 * see fenced-checkpointer.test.mjs › "put, putWrites and deleteThread each run
 * the fence, then beforeWrite, then the inner saver, in that order" and ›
 * "when the fence refuses, put/putWrites/deleteThread all reject with
 * StaleOwnerError, beforeWrite never runs, and the inner MemorySaver is
 * untouched"
 */
class FencedCheckpointer extends BaseCheckpointSaver {
  readonly #inner: BaseCheckpointSaver;
  readonly #fence: CheckpointFence;
  readonly #beforeWrite: (() => Promise<void>) | undefined;

  constructor(inner: BaseCheckpointSaver, fence: CheckpointFence, options: FencedCheckpointerOptions) {
    super(inner.serde);
    this.#inner = inner;
    this.#fence = fence;
    this.#beforeWrite = options.beforeWrite;
  }

  async #guard(): Promise<void> {
    await this.#fence.assertOwner('checkpoint');
    await this.#beforeWrite?.();
  }

  getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return this.#inner.getTuple(config);
  }

  list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    return this.#inner.list(config, options);
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    await this.#guard();
    return this.#inner.put(config, checkpoint, metadata, newVersions);
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    await this.#guard();
    return this.#inner.putWrites(config, writes, taskId);
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.#guard();
    return this.#inner.deleteThread(threadId);
  }

  getNextVersion(current: number | undefined): number {
    return this.#inner.getNextVersion(current);
  }
}

/** Wraps `inner` so every checkpoint write is fenced by `fence`. */
export function createFencedCheckpointer(
  inner: BaseCheckpointSaver,
  fence: CheckpointFence,
  options: FencedCheckpointerOptions = {},
): BaseCheckpointSaver {
  return new FencedCheckpointer(inner, fence, options);
}
