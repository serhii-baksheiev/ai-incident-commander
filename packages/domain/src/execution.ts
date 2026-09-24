/**
 * AIC-56, slice A: the pure domain execution contracts durable run execution
 * is built against - the run status machine (decisions 2-4), the closed
 * exec-key operation registry and `buildExecKey` (decision 5), `canonicalJson`
 * as the one place canonical JSON lives (`.claude/rules/invariants.md`, "one
 * mechanism, one implementation"), and the two integrity error classes
 * decision 12 needs observable evidence to carry a stable `code` on.
 *
 * A worker's ownership attempt - a lease id, a fencing token, a worker id -
 * is deliberately never one of an operation's `exec_key` parts
 * (docs/decisions/durable-run-execution.md, decision 5: "the worker's
 * ownership attempt is never part of an `exec_key`"). It identifies which
 * worker is trying, not which logical operation is being attempted; folding
 * it in would make a retry of the same operation by a different worker look
 * like a different operation, which defeats the replay this registry exists
 * to make possible.
 *
 * No `action.*` operation is registered here: AIC-56 keeps external mutations
 * outside ordinary nodes, owned by the Safe Operations action ledger (AIC-20),
 * not by this registry of committed-result identities. See
 * durable-execution-contract.test.mjs › "no operation name in the registry
 * starts with action.".
 *
 * PostgreSQL, leases, heartbeats and workers do not belong in `packages/domain`
 * (the domain package imports only `zod`, `node:crypto` and its own modules).
 *
 * See durable-execution-contract.test.mjs, this file's spec.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { Evidence, Trial } from './contracts.js';
import { echoed } from './echo.js';

// ---- canonicalJson ---------------------------------------------------------

export type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function canonicalizeValue(value: unknown, ancestors: Set<object>): CanonicalJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonicalJson values must be finite numbers');
    }
    return value;
  }

  if (typeof value !== 'object') {
    throw new TypeError('canonicalJson values must contain only JSON values');
  }

  if (ancestors.has(value)) {
    throw new TypeError('canonicalJson values must not contain circular references');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const canonical: CanonicalJson[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError('canonicalJson arrays must not contain sparse holes');
        }
        canonical.push(canonicalizeValue(value[index], ancestors));
      }
      return canonical;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('canonicalJson objects must be plain JSON objects');
    }

    const source = value as Record<string, unknown>;
    const canonical = Object.create(null) as Record<string, CanonicalJson>;
    for (const key of Object.keys(source).sort()) {
      canonical[key] = canonicalizeValue(source[key], ancestors);
    }
    return canonical;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Canonicalizes a JSON-like value: object keys are sorted recursively and
 * array order is kept, and every object in the result has a null prototype, so two values that differ only in key order canonicalize
 * identically. Refuses a value with no JSON representation - `undefined`
 * inside an object, a function, a bigint, a non-finite number, a circular
 * reference, a sparse array hole, or a non-plain-object prototype.
 *
 * The one place canonical JSON lives in this codebase
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation");
 * `packages/tools/src/replay-key.ts` builds its replay keys on this function
 * rather than keeping its own copy.
 *
 * See durable-execution-contract.test.mjs › "canonicalJson sorts object keys
 * recursively, stable across key-order permutations", › "canonicalJson keeps
 * array order" and › "canonicalJson refuses non-JSON values: undefined in an
 * object, a function, a bigint, NaN and Infinity".
 */
export function canonicalJson(value: unknown): CanonicalJson {
  return canonicalizeValue(value, new Set());
}

// ---- Run status machine -----------------------------------------------------


/**
 * The durable run's statuses, as the "Run lifecycle" table of
 * docs/decisions/durable-run-execution.md states them. Frozen - see
 * durable-execution-contract.test.mjs › "RUN_STATUSES is exactly the five
 * documented statuses, frozen".
 */
export const RUN_STATUSES = Object.freeze(['queued', 'running', 'waiting_human', 'completed', 'failed'] as const);

export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * The transitions of the "Run lifecycle" table in
 * docs/decisions/durable-run-execution.md. `completed` and `failed` are
 * absorbing - no pair starting there is listed. The record and this set are
 * kept equal by durable-run-execution-adr.test.mjs › "states the run lifecycle
 * as a table that matches the domain transitions in both directions".
 */
const ALLOWED_RUN_TRANSITIONS: ReadonlySet<string> = new Set([
  'queued->running',
  'queued->failed',
  'running->waiting_human',
  'running->completed',
  'running->failed',
  'running->queued',
  'waiting_human->queued',
]);

/**
 * Refuses any run-status transition outside `ALLOWED_RUN_TRANSITIONS`. See
 * durable-execution-contract.test.mjs › "assertRunTransition allows exactly
 * the seven documented transitions, against a literal 5x5 table", › "completed and failed are absorbing: every
 * transition out of them is refused" and › "assertRunTransition throws on an
 * unknown status on either side".
 *
 * @throws {Error} when `from` or `to` is not one of `RUN_STATUSES`, or the
 * pair is not one of the allowed transitions.
 */
export function assertRunTransition(from: string, to: string): void {
  if (!(RUN_STATUSES as readonly string[]).includes(from)) {
    throw new Error(`unknown run status: ${echoed(from)}`);
  }
  if (!(RUN_STATUSES as readonly string[]).includes(to)) {
    throw new Error(`unknown run status: ${echoed(to)}`);
  }
  if (!ALLOWED_RUN_TRANSITIONS.has(`${from}->${to}`)) {
    throw new Error(`run transition not allowed: ${from} -> ${to}`);
  }
}

// ---- Closed exec-key operation registry -------------------------------------

interface ExecutionOperationDefinition {
  readonly schema: z.ZodTypeAny;
  readonly order: readonly string[];
}

const TOOL_TRIAL_PARTS_ORDER = Object.freeze(['runId', 'testId', 'trialAttempt'] as const);
// A Trial attempt counts from 1; see durable-execution-contract.test.mjs ›
// "buildExecKey refuses trialAttempt 0: a Trial attempt counts from 1".
const TOOL_TRIAL_PARTS_SCHEMA = z.strictObject({
  runId: z.string().min(1),
  testId: z.string().min(1),
  trialAttempt: z.number().int().positive(),
});

const MODEL_ROLE_PARTS_ORDER = Object.freeze([
  'runId',
  'role',
  'promptVersion',
  'iterationsUsed',
  'challengeRounds',
  'resumeCount',
] as const);
const MODEL_ROLE_PARTS_SCHEMA = z.strictObject({
  runId: z.string().min(1),
  role: z.string().min(1),
  promptVersion: z.string().min(1),
  iterationsUsed: z.number().int().nonnegative(),
  challengeRounds: z.number().int().nonnegative(),
  resumeCount: z.number().int().nonnegative(),
});

/**
 * The closed registry of exec-key operations: every logical side-effecting or
 * expensive operation whose committed result must survive a retry or
 * recovery (decision 5), and nothing else. Frozen; naming exactly `tool.trial`
 * (a Trial's re-observable attempt) and `model.role` (one role's model
 * invocation). See durable-execution-contract.test.mjs › "EXECUTION_OPERATIONS
 * is frozen and names exactly tool.trial and model.role" and › "no operation
 * name in the registry starts with action.".
 */
export const EXECUTION_OPERATIONS = Object.freeze({
  'tool.trial': Object.freeze({
    schema: TOOL_TRIAL_PARTS_SCHEMA,
    order: TOOL_TRIAL_PARTS_ORDER,
  }),
  'model.role': Object.freeze({
    schema: MODEL_ROLE_PARTS_SCHEMA,
    order: MODEL_ROLE_PARTS_ORDER,
  }),
} as const);

export type ExecutionOperation = keyof typeof EXECUTION_OPERATIONS;

const EXEC_KEY_TUPLE_VERSION = 1 as const;

/**
 * Builds the exec_key for one logical operation: `<op>/sha256:<64 hex>`,
 * hashing `JSON.stringify(['aic.exec', op, 1, ...parts in the registry's
 * declared order])` with `node:crypto`'s `sha256`. Stable across the input
 * `parts` object's own key order, because the hashed tuple is built from the
 * registry's declared order, not from the input's insertion order. Refuses an
 * operation name that is not an own key of `EXECUTION_OPERATIONS`, and
 * refuses `parts` that are missing a field, carry an extra field (including a
 * worker-ownership field such as `workerId`, and an own `__proto__` key), or
 * carry a field of the wrong type. `parts` are read through `canonicalJson`
 * first, so only the caller's own fields count - never one a prototype
 * supplies - and then through the operation's zod strict object.
 *
 * See durable-execution-contract.test.mjs › "buildExecKey returns
 * <op>/sha256:<64 hex> for a valid tool.trial and model.role input", › "pins
 * the exact key for one fixed tool.trial and one fixed model.role input", ›
 * "is stable regardless of the parts object key order", › "gives a different
 * key for a different trialAttempt, and a different runId", › "never
 * collides between tool.trial and model.role", › "refuses an operation name
 * outside the registry", › "refuses a missing part", › "refuses an extra
 * part, including a worker-ownership field" and › "refuses a part of the
 * wrong type", › "refuses an operation name the registry only inherits from
 * Object.prototype", › "refuses a part that only a polluted Object.prototype
 * supplies" and › "refuses an extra own __proto__ part rather than silently
 * dropping it".
 *
 * @throws {Error} when `op` is not a key of `EXECUTION_OPERATIONS`, or `parts`
 * fails that operation's schema.
 */
export function buildExecKey(op: string, parts: unknown): string {
  // `Object.hasOwn` coerces its key argument through `ToPropertyKey`, which
  // calls a non-string value's own `toString()` - so this must run BEFORE
  // that call, or an object whose `toString()` returns a registered
  // operation name would be read as that operation instead of refused. See
  // durable-execution-contract.test.mjs › "buildExecKey refuses a non-string
  // op, without coercing it through ToPropertyKey into a registered
  // operation name".
  if (typeof op !== 'string' || !Object.hasOwn(EXECUTION_OPERATIONS, op)) {
    throw new Error(`unknown execution operation: ${echoed(op)}`);
  }
  const definition = (EXECUTION_OPERATIONS as Record<string, ExecutionOperationDefinition>)[op]!;

  const canonicalParts = canonicalJson(parts);
  // zod's strict object drops an own `__proto__` key instead of reporting it,
  // so extra keys are checked against the registry's own list first.
  if (canonicalParts !== null && typeof canonicalParts === 'object' && !Array.isArray(canonicalParts)) {
    const extra = Object.keys(canonicalParts).filter((key) => !definition.order.includes(key));
    if (extra.length > 0) {
      throw new Error(`invalid parts for execution operation ${op}: unrecognized_keys`);
    }
  }
  const parsed = definition.schema.safeParse(canonicalParts);
  if (!parsed.success) {
    const codes = parsed.error.issues.map((issue) => issue.code).join(', ');
    throw new Error(`invalid parts for execution operation ${op}: ${codes}`);
  }

  const parsedParts = parsed.data as Record<string, unknown>;
  const orderedValues = definition.order.map((key) => parsedParts[key]);
  const tuple = ['aic.exec', op, EXEC_KEY_TUPLE_VERSION, ...orderedValues];
  const digest = createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
  return `${op}/sha256:${digest}`;
}

const EXEC_KEY_OP_PATTERN = Object.keys(EXECUTION_OPERATIONS)
  .map((op) => op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

/**
 * Accepts exactly the strings `buildExecKey` can produce: `<op>/sha256:<64
 * lowercase hex>` for an `op` in `EXECUTION_OPERATIONS`, and nothing else.
 * See durable-execution-contract.test.mjs › "ExecKeySchema accepts a key
 * buildExecKey builds", › "ExecKeySchema refuses a string without the
 * <op>/sha256: shape" and › "ExecKeySchema refuses an op outside the
 * registry".
 */
export const ExecKeySchema = z.string().regex(new RegExp(`^(?:${EXEC_KEY_OP_PATTERN})/sha256:[0-9a-f]{64}$`));

// ---- Integrity errors --------------------------------------------------------

/**
 * Raised when a result about to be committed for an exec_key disagrees with
 * the result already committed for it (decision 6: committed results are
 * immutable). The stable `code` is what the durable evidence of decision 12
 * names. See durable-execution-contract.test.mjs ›
 * "ExecutionIntegrityViolation carries code, execKey and is an Error named
 * after its class".
 */
export class ExecutionIntegrityViolation extends Error {
  readonly code = 'execution.integrity_violation' as const;
  readonly execKey: string;

  constructor(message: string, { execKey }: { execKey: string }) {
    super(message);
    this.name = 'ExecutionIntegrityViolation';
    this.execKey = execKey;
  }
}

/**
 * Raised when a worker that has lost fencing authority (decision 3) attempts
 * a commit. See durable-execution-contract.test.mjs › "StaleOwnerError
 * carries code and is an Error named after its class".
 */
export class StaleOwnerError extends Error {
  readonly code = 'execution.fenced' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StaleOwnerError';
  }
}

// ---- The committed-execution port -----------------------------------------

/** The domain records a committed operation writes beside its result. */
export interface CommittedProjection {
  readonly trials?: readonly Trial[];
  readonly evidence?: readonly Evidence[];
}

/**
 * The port through which the graph commits the result of one logical
 * operation (decisions 5-7 of docs/decisions/durable-run-execution.md): the
 * graph depends on this and never on a storage implementation. `project`
 * receives the committed result and returns the records to write with it.
 * `@aic/persistence`'s run write context is the implementation; see
 * durable-tool-replay.test.mjs › "compiles the durable-tool-replay type
 * contract: RunWriteContext satisfies CommittedExecution".
 */
export interface CommittedExecution {
  committed<T>(
    execKey: string,
    compute: () => Promise<T>,
    options?: {
      readonly project?: (result: T) => CommittedProjection | undefined;
      readonly inputFingerprint?: string;
    },
  ): Promise<T>;
}
