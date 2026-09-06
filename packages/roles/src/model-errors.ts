/**
 * The refusals of the model path, each named for what a caller must do about it.
 *
 * They are their own types rather than `Error` with a message so that a caller
 * CAN tell them apart: an absent credential is an operator configuration
 * problem, a spent budget is a cap this lane chose, and a provider refusal is
 * neither.
 *
 * ⚠ No caller distinguishes them yet. There is no `instanceof` against any of
 * these types outside `dist/`, and the one `catch` on the path —
 * `scripts/eval-live-model.mjs` — prints `name: message` and exits 1 the same
 * way for all four. An earlier version of this comment said the lane "branches
 * on them"; it does not, and `code-reviewer` and `prose-reviewer` both measured
 * that at the AIC-94 gate. The types are the affordance, not the behaviour.
 */

/**
 * No provider credential is configured.
 *
 * Carries the variable NAME and never a value: the whole point of this error is
 * to say what to export, and an error object that could carry a key is one more
 * place a key can be logged.
 * see roles-port-contract.test.mjs › "names the missing variable in the error the
 * lane entry throws"
 */
export class MissingModelCredentialError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(
      `no model provider credential is configured: export ${variable} to run the live model lane`,
    );
    this.name = 'MissingModelCredentialError';
    this.variable = variable;
  }
}

/**
 * The declared call cap for one lane execution is spent.
 *
 * Thrown BEFORE the call rather than after it, so the cap bounds what is spent
 * rather than what is reported.
 * see roles-port-contract.test.mjs › "refuses the call past the declared cap
 * instead of spending it"
 */
export class ModelCallBudgetExceededError extends Error {
  readonly maxCalls: number;

  constructor(maxCalls: number) {
    super(`model call budget exhausted: this lane is capped at ${maxCalls} calls`);
    this.name = 'ModelCallBudgetExceededError';
    this.maxCalls = maxCalls;
  }
}

/**
 * The provider refused, or answered in a shape this port cannot read.
 *
 * `status` is the HTTP status when there was one and `undefined` when the
 * failure was the payload rather than the response — a distinction the lane
 * needs, because the first is a retryable condition an operator can see in the
 * provider console and the second is a defect here.
 * see roles-port-contract.test.mjs › "reports a provider refusal as a failed
 * completion rather than an empty one"
 * see roles-port-contract.test.mjs › "refuses a response that carries no text
 * block instead of returning an empty string"
 */
export class ModelCompletionError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ModelCompletionError';
    if (status !== undefined) this.status = status;
  }
}

/**
 * A model role answered with something the domain schemas refuse.
 *
 * Separate from `ModelCompletionError`: the provider answered, the transport
 * worked, and the content is what failed. A lane that reported those as one
 * failure could not tell an outage from a quality problem, which is the
 * distinction this whole item exists to keep.
 * see roles-model-nodes.test.mjs › "refuses a hypothesis set the domain schema
 * does not accept"
 */
export class ModelRoleOutputError extends Error {
  readonly role: string;

  constructor(role: string, detail: string) {
    super(`model role ${role} produced output the domain refuses: ${detail}`);
    this.name = 'ModelRoleOutputError';
    this.role = role;
  }
}
