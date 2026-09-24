import { StaleOwnerError } from '@aic/domain';
import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type DeltaChannelHistory,
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

  /**
   * Runs once a write has landed. The fence check and the inner write are not
   * atomic, so a writer can lose ownership between them; re-checking afterwards
   * turns such a write into a recorded `checkpoint_fork` instead of a silent
   * one (AIC-57: stale checkpoint writes are observable, not silent). The write
   * is not undone — it landed on another connection — and the caller is not
   * failed by the record: the next owner's resume reconciles through its
   * committed node results. see fenced-checkpointer.test.mjs › "put records a
   * checkpoint_fork when the post-write ownership recheck fails, without
   * failing the caller or undoing the landed write"
   */
  async #recheck(): Promise<void> {
    try {
      await this.#fence.assertOwner('checkpoint_fork');
    } catch (error) {
      // A plain refusal was recorded by the fence under `checkpoint_fork`, and
      // that record is the observation. Anything else — a refusal whose record
      // failed (it carries the failure as `cause`), a lost connection — would
      // leave the fork unrecorded, so it surfaces instead of vanishing. see
      // fenced-checkpointer.test.mjs › "a post-write recheck that fails for any
      // reason other than a recorded fence refusal fails the write loudly
      // instead of making the fork silent"
      if (error instanceof StaleOwnerError && error.cause === undefined) return;
      throw error;
    }
  }

  async #write<T>(write: () => Promise<T>): Promise<T> {
    await this.#guard();
    const result = await write();
    await this.#recheck();
    return result;
  }

  getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return this.#inner.getTuple(config);
  }

  list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    return this.#inner.list(config, options);
  }

  /**
   * Reads are not fenced (this class's own header), and delegating here is
   * what keeps that true for this member too: `BaseCheckpointSaver` ships a
   * default implementation that reconstructs history through `getTuple` +
   * `parentConfig`, which on THIS class would walk the fenced wrapper's own
   * (unfenced, but still indirect) `getTuple` instead of an inner saver's own
   * storage-aware override — see fenced-checkpointer.test.mjs ›
   * "getDeltaChannelHistory delegates to the inner saver, not to the
   * inherited base-class default".
   */
  getDeltaChannelHistory(options: {
    config: RunnableConfig;
    channels: string[];
  }): Promise<Record<string, DeltaChannelHistory>> {
    return this.#inner.getDeltaChannelHistory(options);
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    return this.#write(() => this.#inner.put(config, checkpoint, metadata, newVersions));
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    return this.#write(() => this.#inner.putWrites(config, writes, taskId));
  }

  async deleteThread(threadId: string): Promise<void> {
    return this.#write(() => this.#inner.deleteThread(threadId));
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
