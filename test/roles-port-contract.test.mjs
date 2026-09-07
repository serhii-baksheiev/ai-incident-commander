/**
 * AIC-94, step 1: the reference-model port and its configuration.
 *
 * The acceptance criterion this file pins is the one that is decidable without a
 * provider credential and without a network: an environment that carries no key
 * must produce a NAMED refusal rather than a silently disabled lane. That is why
 * the refusal is the part made mechanical here.
 *
 * ⚠ This header used to add that everything else in the model path was
 * "unreachable here". That was written for AIC-94 and is no longer true: the
 * credentialed path has been executed and its records are committed under
 * `docs/evidence/final-evaluation/`. What remains true is narrower — the SUITE
 * reaches the provider from no test in this file; the rows below drive the model
 * path through an INJECTED transport.
 *
 * The environment is an ARGUMENT everywhere in this file, never `process.env`,
 * which is what makes `resolveTracingConfig` in `packages/observability`
 * decidable in a test and is the convention the model configuration follows.
 * That no workspace package reads the process environment is a check rather
 * than a sentence:
 * see roles-boundary.test.mjs › "keeps every process-environment read out of the
 * workspace packages"
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as roles from '@aic/roles';

function requireExport(name) {
  assert.ok(
    roles[name] !== undefined,
    `@aic/roles must export ${name}`,
  );
  return roles[name];
}

/**
 * A key-shaped string assembled at runtime.
 *
 * Never written out as a literal: `.claude/rules/autonomy.md` ("Never") requires
 * a fixture that needs a credential SHAPE to build it rather than spell it, or
 * the repository's own secret guard reports its test data as a leak.
 */
function fakeApiKey() {
  return ['sk', 'ant', 'test', '0'.repeat(24)].join('-');
}

/**
 * The control characters a credential must never carry into a header value.
 *
 * `\n` and `\r` are the two that arrive by accident — a key copied out of a
 * wrapped terminal, or `$(cat key.txt)` on a file with a blank second line.
 *
 * ⚠ Only `NUL`, `LF` and `CR` actually leak: measured mid-value, those three
 * make `Headers.append` quote the whole header value, while `TAB` and `DEL` are
 * accepted and sent. The guard refuses the wider class anyway, and the reason is
 * NOT "a key nobody could have used" — a `TAB` is a legal header value, so
 * refusing it IS a false refusal. It is accepted because no real credential
 * carries one, and because a guard pinned to a dependency's exact validator has
 * to be re-measured every time that dependency moves. Stating the cost honestly
 * rather than denying it, after an earlier version of this comment denied it.
 */
const CONTROL_CHARACTERS = ['\n', '\r', '\t', '\u0000'];

/** The same key shape, assembled at runtime, with one character spliced inside it. */
function fakeApiKeyCarrying(controlCharacter) {
  const key = fakeApiKey();
  const middle = Math.floor(key.length / 2);
  return `${key.slice(0, middle)}${controlCharacter}${key.slice(middle)}`;
}

/**
 * Assert that nothing a caller can read off the refusal carries the credential.
 *
 * Written against every surface rather than `message` alone, and against each
 * SEGMENT either side of the control character as well as the whole string, so
 * that an error type which echoes only the first line of the value — which is
 * the whole key up to the break — fails this too.
 */
function assertHidesCredential(error, apiKey) {
  const surfaces = [
    error.message,
    String(error),
    error.stack ?? '',
    JSON.stringify(error, Object.getOwnPropertyNames(error)),
  ].join('\n');

  for (const secret of [apiKey, ...apiKey.split(/[\u0000-\u001f]/)]) {
    if (secret.length < 8) continue;
    assert.equal(
      surfaces.includes(secret),
      false,
      'a refusal that quotes the value it refused writes the credential to whatever log reads the error',
    );
  }
}

test('refuses the live model lane with a named variable when no provider credential is set', () => {
  const resolveModelConfig = requireExport('resolveModelConfig');
  const MODEL_API_KEY_VARIABLE = requireExport('MODEL_API_KEY_VARIABLE');

  const resolved = resolveModelConfig({});

  assert.deepEqual(resolved, {
    available: false,
    missing: MODEL_API_KEY_VARIABLE,
  });
  assert.equal(
    MODEL_API_KEY_VARIABLE,
    'ANTHROPIC_API_KEY',
    'the reference provider is configured through one named variable',
  );
});

test('names the missing variable in the error the lane entry throws', () => {
  const requireModelConfig = requireExport('requireModelConfig');
  const MissingModelCredentialError = requireExport('MissingModelCredentialError');
  const MODEL_API_KEY_VARIABLE = requireExport('MODEL_API_KEY_VARIABLE');

  assert.throws(
    () => requireModelConfig({}),
    (error) => {
      assert.ok(
        error instanceof MissingModelCredentialError,
        'the refusal must be its own error type, not a bare Error',
      );
      assert.equal(error.variable, MODEL_API_KEY_VARIABLE);
      assert.match(error.message, new RegExp(MODEL_API_KEY_VARIABLE));
      return true;
    },
  );
});

test('resolves an available configuration without ever returning the key', () => {
  const resolveModelConfig = requireExport('resolveModelConfig');
  const MODEL_API_KEY_VARIABLE = requireExport('MODEL_API_KEY_VARIABLE');
  const REFERENCE_MODEL_PROVIDER = requireExport('REFERENCE_MODEL_PROVIDER');
  const REFERENCE_MODEL_ID = requireExport('REFERENCE_MODEL_ID');
  const apiKey = fakeApiKey();

  const resolved = resolveModelConfig({ [MODEL_API_KEY_VARIABLE]: apiKey });

  assert.deepEqual(resolved, {
    available: true,
    provider: REFERENCE_MODEL_PROVIDER,
    modelId: REFERENCE_MODEL_ID,
    apiKeyVariable: MODEL_API_KEY_VARIABLE,
  });
  assert.equal(
    JSON.stringify(resolved).includes(apiKey),
    false,
    'the resolved configuration must never carry the credential itself',
  );
});

test('treats an empty or whitespace credential as absent rather than as configured', () => {
  const resolveModelConfig = requireExport('resolveModelConfig');
  const MODEL_API_KEY_VARIABLE = requireExport('MODEL_API_KEY_VARIABLE');

  for (const value of ['', '   ']) {
    assert.deepEqual(
      resolveModelConfig({ [MODEL_API_KEY_VARIABLE]: value }),
      { available: false, missing: MODEL_API_KEY_VARIABLE },
      'an exported-but-empty variable is not a credential',
    );
  }
});

test('treats a credential carrying a control character as absent rather than as configured', () => {
  // A key copied out of a wrapped terminal, or read with
  // `export ANTHROPIC_API_KEY="$(cat key.txt)"` from a two-line file — command
  // substitution strips only the TRAILING newline — carries an inner control
  // character. Such a value is not empty after `trim`, so it used to resolve as
  // a configured lane, and the string then reached a transport that reports an
  // invalid header value by quoting it.
  const resolveModelConfig = requireExport('resolveModelConfig');
  const MODEL_API_KEY_VARIABLE = requireExport('MODEL_API_KEY_VARIABLE');

  for (const controlCharacter of CONTROL_CHARACTERS) {
    assert.deepEqual(
      resolveModelConfig({
        [MODEL_API_KEY_VARIABLE]: fakeApiKeyCarrying(controlCharacter),
      }),
      { available: false, missing: MODEL_API_KEY_VARIABLE },
      'a value no request could carry as a header is not a credential',
    );
  }
});

test('reads the credential variable as an own property of the supplied environment', () => {
  const resolveModelConfig = requireExport('resolveModelConfig');
  const MODEL_API_KEY_VARIABLE = requireExport('MODEL_API_KEY_VARIABLE');
  const polluted = Object.create({ [MODEL_API_KEY_VARIABLE]: fakeApiKey() });

  assert.deepEqual(
    resolveModelConfig(polluted),
    { available: false, missing: MODEL_API_KEY_VARIABLE },
    'an inherited variable would turn the lane on from an environment that owns nothing',
  );
});

test('overrides the model id from the environment when one is declared', () => {
  const resolveModelConfig = requireExport('resolveModelConfig');
  const MODEL_API_KEY_VARIABLE = requireExport('MODEL_API_KEY_VARIABLE');
  const MODEL_ID_VARIABLE = requireExport('MODEL_ID_VARIABLE');

  const resolved = resolveModelConfig({
    [MODEL_API_KEY_VARIABLE]: fakeApiKey(),
    [MODEL_ID_VARIABLE]: 'claude-declared-by-the-operator',
  });

  assert.equal(resolved.available, true);
  assert.equal(resolved.modelId, 'claude-declared-by-the-operator');
});

/* -------------------------------------------------------------------------- */
/* the usage ledger — the out-of-band channel D3 requires                      */
/* -------------------------------------------------------------------------- */

test('records what a completion spent on its own axes and never a composite', () => {
  const createModelUsageLedger = requireExport('createModelUsageLedger');
  const ledger = createModelUsageLedger({ maxCalls: 4 });

  assert.deepEqual(ledger.read(), {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
  });

  ledger.record({ inputTokens: 11, outputTokens: 5 });
  ledger.record({ inputTokens: 7, outputTokens: 3 });

  assert.deepEqual(ledger.read(), {
    calls: 2,
    inputTokens: 18,
    outputTokens: 8,
  });
});

test('refuses the call past the declared cap instead of spending it', () => {
  const createModelUsageLedger = requireExport('createModelUsageLedger');
  const ModelCallBudgetExceededError = requireExport('ModelCallBudgetExceededError');
  const ledger = createModelUsageLedger({ maxCalls: 1 });

  ledger.record({ inputTokens: 1, outputTokens: 1 });

  assert.throws(
    () => ledger.record({ inputTokens: 1, outputTokens: 1 }),
    (error) => {
      assert.ok(error instanceof ModelCallBudgetExceededError);
      assert.equal(error.maxCalls, 1);
      return true;
    },
  );
  assert.deepEqual(
    ledger.read(),
    { calls: 1, inputTokens: 1, outputTokens: 1 },
    'a refused call must not be counted as spent',
  );
});

/* -------------------------------------------------------------------------- */
/* the provider adapter — transport injected, so no network is reached         */
/* -------------------------------------------------------------------------- */

function completionResponse({ text, inputTokens = 12, outputTokens = 4 }) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      };
    },
    async text() {
      return '';
    },
  };
}

test('returns the completion text and the usage a node can declare', async () => {
  const createReferenceModelPort = requireExport('createReferenceModelPort');
  const createModelUsageLedger = requireExport('createModelUsageLedger');
  const ledger = createModelUsageLedger({ maxCalls: 2 });
  const seen = [];

  const port = createReferenceModelPort({
    apiKey: fakeApiKey(),
    modelId: 'claude-under-test',
    ledger,
    async fetchImpl(url, init) {
      seen.push({ url, init });
      return completionResponse({ text: '{"ok":true}' });
    },
  });

  const completion = await port.complete({
    system: 'system instruction',
    prompt: 'the question',
    maxOutputTokens: 1024,
  });

  // `stopReason` joins the pinned shape rather than being excluded from it: the
  // shared fixture answers `end_turn`, and a completion that does NOT carry the
  // provider's reason is how a truncation reached a role as an ordinary string
  // and was reported as the model writing bad JSON.
  assert.deepEqual(completion, {
    text: '{"ok":true}',
    modelId: 'claude-under-test',
    usage: { inputTokens: 12, outputTokens: 4 },
    stopReason: 'end_turn',
  });
  assert.deepEqual(ledger.read(), {
    calls: 1,
    inputTokens: 12,
    outputTokens: 4,
  });
  assert.equal(seen.length, 1, 'one completion is one request');
});

test('counts a reservation before the request, so concurrent calls cannot share one slot', async () => {
  // `reserve` used to only READ the completed-call count, which nothing
  // incremented until a response came back — so the cap held for a sequential
  // caller and for no other. Found by `security-scanner` at the AIC-94 gate.
  const createReferenceModelPort = requireExport('createReferenceModelPort');
  const createModelUsageLedger = requireExport('createModelUsageLedger');
  const ModelCallBudgetExceededError = requireExport('ModelCallBudgetExceededError');
  const ledger = createModelUsageLedger({ maxCalls: 2 });

  let release;
  const inFlight = new Promise((resolve) => {
    release = resolve;
  });
  let started = 0;

  const port = createReferenceModelPort({
    apiKey: fakeApiKey(),
    modelId: 'claude-under-test',
    ledger,
    async fetchImpl() {
      started += 1;
      await inFlight;
      return completionResponse({ text: '{"ok":true}' });
    },
  });

  const request = { system: 's', prompt: 'p', maxOutputTokens: 16 };
  const first = port.complete(request);
  const second = port.complete(request);
  // A third, started while neither of the first two has answered, must be
  // refused: two slots are already reserved even though nothing was recorded.
  await assert.rejects(() => port.complete(request), ModelCallBudgetExceededError);
  assert.equal(started, 2, 'only the two reserved requests reached the transport');

  release();
  await Promise.all([first, second]);
  assert.equal(ledger.read().calls, 2);
});

test('gives the provider request a deadline the caller can override', async () => {
  const createReferenceModelPort = requireExport('createReferenceModelPort');
  const createModelUsageLedger = requireExport('createModelUsageLedger');
  const seen = [];

  const port = createReferenceModelPort({
    apiKey: fakeApiKey(),
    modelId: 'claude-under-test',
    ledger: createModelUsageLedger({ maxCalls: 2 }),
    async fetchImpl(url, init) {
      seen.push(init);
      return completionResponse({ text: '{"ok":true}' });
    },
  });

  await port.complete({ system: 's', prompt: 'p', maxOutputTokens: 16 });
  assert.ok(
    seen[0].signal instanceof AbortSignal,
    'a hung provider must not stall a bounded run: the request carries a deadline',
  );

  const caller = new AbortController();
  await port.complete({
    system: 's',
    prompt: 'p',
    maxOutputTokens: 16,
    signal: caller.signal,
  });
  assert.equal(seen[1].signal, caller.signal, "the caller's own signal wins");
});

test('refuses to follow a redirect, because the credential header would travel with it', async () => {
  // `x-api-key` is a CUSTOM header, so the fetch spec's cross-origin redirect
  // stripping — which covers `Authorization` — does not apply to it. Found by
  // `security-scanner` at the AIC-94 gate.
  const createReferenceModelPort = requireExport('createReferenceModelPort');
  const createModelUsageLedger = requireExport('createModelUsageLedger');
  const seen = [];

  const port = createReferenceModelPort({
    apiKey: fakeApiKey(),
    modelId: 'claude-under-test',
    ledger: createModelUsageLedger({ maxCalls: 1 }),
    async fetchImpl(url, init) {
      seen.push(init);
      return completionResponse({ text: '{"ok":true}' });
    },
  });

  await port.complete({ system: 's', prompt: 'p', maxOutputTokens: 16 });

  assert.equal(
    seen[0].redirect,
    'error',
    'a redirect must fail rather than carry x-api-key to another origin',
  );
});

test('never puts the credential anywhere but the request it authenticates', async () => {
  const createReferenceModelPort = requireExport('createReferenceModelPort');
  const createModelUsageLedger = requireExport('createModelUsageLedger');
  const apiKey = fakeApiKey();
  const captured = [];

  const port = createReferenceModelPort({
    apiKey,
    modelId: 'claude-under-test',
    ledger: createModelUsageLedger({ maxCalls: 1 }),
    async fetchImpl(url, init) {
      captured.push({ url, init });
      return completionResponse({ text: 'answer' });
    },
  });

  const completion = await port.complete({
    system: 'system instruction',
    prompt: 'the question',
    maxOutputTokens: 64,
  });

  const [request] = captured;
  assert.equal(
    Object.values(request.init.headers).includes(apiKey),
    true,
    'the key travels in the request header and nowhere else',
  );
  assert.equal(request.init.body.includes(apiKey), false, 'not in the body');
  assert.equal(String(request.url).includes(apiKey), false, 'not in the url');
  assert.equal(
    JSON.stringify(completion).includes(apiKey),
    false,
    'not in what the port hands back',
  );
});

test('refuses a credential carrying a control character instead of letting the transport quote it back', () => {
  // The transport is what turns this from a bad request into a leak:
  // `Headers.append` reports an invalid header value by QUOTING it, and this
  // lane's command writes `${error.name}: ${error.message}` to stderr, which in
  // CI is a retained job log. So the port refuses such a credential with its
  // own named error — the one that carries no value — and the string never
  // reaches a transport at all.
  const createReferenceModelPort = requireExport('createReferenceModelPort');
  const createModelUsageLedger = requireExport('createModelUsageLedger');
  const ModelCompletionError = requireExport('ModelCompletionError');

  for (const controlCharacter of CONTROL_CHARACTERS) {
    const apiKey = fakeApiKeyCarrying(controlCharacter);
    let requests = 0;

    assert.throws(
      () =>
        createReferenceModelPort({
          apiKey,
          modelId: 'claude-under-test',
          ledger: createModelUsageLedger({ maxCalls: 1 }),
          async fetchImpl() {
            requests += 1;
            return completionResponse({ text: 'answer' });
          },
        }),
      (error) => {
        assert.ok(
          error instanceof ModelCompletionError,
          "the refusal must be this module's own named error, not one the provider stack raised",
        );
        assertHidesCredential(error, apiKey);
        return true;
      },
    );
    assert.equal(requests, 0, 'a credential the port refuses never reaches a transport');
  }
});

test('accepts a legitimate credential, including one padded with surrounding spaces', async () => {
  // The other half of the row above, and the reason it is a control-character
  // check rather than a whitespace one: surrounding spaces are harmless — a
  // header value is normalized before it is validated — so a key that picked
  // some up from a shell must not start being refused.
  const createReferenceModelPort = requireExport('createReferenceModelPort');
  const createModelUsageLedger = requireExport('createModelUsageLedger');

  for (const apiKey of [fakeApiKey(), `  ${fakeApiKey()}  `]) {
    const captured = [];
    const port = createReferenceModelPort({
      apiKey,
      modelId: 'claude-under-test',
      ledger: createModelUsageLedger({ maxCalls: 1 }),
      async fetchImpl(url, init) {
        captured.push(init);
        return completionResponse({ text: 'answer' });
      },
    });

    await port.complete({ system: 's', prompt: 'p', maxOutputTokens: 16 });
    assert.equal(captured.length, 1, 'a usable credential still authenticates one request');
  }
});

test('reports a provider refusal as a failed completion rather than an empty one', async () => {
  const createReferenceModelPort = requireExport('createReferenceModelPort');
  const createModelUsageLedger = requireExport('createModelUsageLedger');
  const ModelCompletionError = requireExport('ModelCompletionError');
  const ledger = createModelUsageLedger({ maxCalls: 2 });

  const port = createReferenceModelPort({
    apiKey: fakeApiKey(),
    modelId: 'claude-under-test',
    ledger,
    async fetchImpl() {
      return {
        ok: false,
        status: 429,
        async json() {
          return { error: { message: 'rate limited' } };
        },
        async text() {
          return 'rate limited';
        },
      };
    },
  });

  await assert.rejects(
    () => port.complete({ system: 's', prompt: 'p', maxOutputTokens: 16 }),
    (error) => {
      assert.ok(error instanceof ModelCompletionError);
      assert.equal(error.status, 429);
      return true;
    },
  );
  assert.deepEqual(
    ledger.read(),
    { calls: 0, inputTokens: 0, outputTokens: 0 },
    'a refused request spent no completion this lane may report',
  );
});

test('refuses a response that carries no text block instead of returning an empty string', async () => {
  const createReferenceModelPort = requireExport('createReferenceModelPort');
  const createModelUsageLedger = requireExport('createModelUsageLedger');
  const ModelCompletionError = requireExport('ModelCompletionError');

  const port = createReferenceModelPort({
    apiKey: fakeApiKey(),
    modelId: 'claude-under-test',
    ledger: createModelUsageLedger({ maxCalls: 2 }),
    async fetchImpl() {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            content: [],
            usage: { input_tokens: 3, output_tokens: 0 },
          };
        },
        async text() {
          return '';
        },
      };
    },
  });

  await assert.rejects(
    () => port.complete({ system: 's', prompt: 'p', maxOutputTokens: 16 }),
    ModelCompletionError,
  );
});

test('reads the completion off own properties of the provider payload', async () => {
  const createReferenceModelPort = requireExport('createReferenceModelPort');
  const createModelUsageLedger = requireExport('createModelUsageLedger');
  const ModelCompletionError = requireExport('ModelCompletionError');

  const port = createReferenceModelPort({
    apiKey: fakeApiKey(),
    modelId: 'claude-under-test',
    ledger: createModelUsageLedger({ maxCalls: 2 }),
    async fetchImpl() {
      return {
        ok: true,
        status: 200,
        async json() {
          // A payload owning `content` but inheriting `usage`: read through the
          // prototype chain and the lane publishes a token count no response
          // declared.
          return Object.assign(
            Object.create({ usage: { input_tokens: 999, output_tokens: 999 } }),
            { content: [{ type: 'text', text: 'answer' }] },
          );
        },
        async text() {
          return '';
        },
      };
    },
  });

  await assert.rejects(
    () => port.complete({ system: 's', prompt: 'p', maxOutputTokens: 16 }),
    ModelCompletionError,
  );
});

test('stops at the declared call cap before issuing the request', async () => {
  const createReferenceModelPort = requireExport('createReferenceModelPort');
  const createModelUsageLedger = requireExport('createModelUsageLedger');
  const ModelCallBudgetExceededError = requireExport('ModelCallBudgetExceededError');
  const ledger = createModelUsageLedger({ maxCalls: 1 });
  let requests = 0;

  const port = createReferenceModelPort({
    apiKey: fakeApiKey(),
    modelId: 'claude-under-test',
    ledger,
    async fetchImpl() {
      requests += 1;
      return completionResponse({ text: 'answer' });
    },
  });

  await port.complete({ system: 's', prompt: 'p', maxOutputTokens: 16 });
  await assert.rejects(
    () => port.complete({ system: 's', prompt: 'p', maxOutputTokens: 16 }),
    ModelCallBudgetExceededError,
  );

  assert.equal(
    requests,
    1,
    'the capped call must never reach the transport: a cap checked after the request is a report, not a bound',
  );
});

/**
 * The port hands the ledger the budget of the call it is ABOUT to make.
 *
 * The output-token cap can only bound spend if it sees completions that are in
 * flight; a reservation carrying no estimate degrades it to the recorded-only
 * check that granted fifty concurrent calls against a thousand-token budget.
 * `reference-model-port.ts` says so in the comment above the reserve, and until
 * this row nothing pinned it: every other ledger row in this file calls
 * `reserve` DIRECTLY, so replacing the port's `ledger.reserve(request.maxOutputTokens)`
 * with `ledger.reserve()` left the whole suite green — measured by
 * `code-reviewer` at the AIC-19 gate.
 */
test('reserves the requested output budget before the call, so in-flight completions count against the cap', async () => {
  const createReferenceModelPort = requireExport('createReferenceModelPort');
  const createModelUsageLedger = requireExport('createModelUsageLedger');
  const inner = createModelUsageLedger({ maxCalls: 4, maxOutputTokens: 1000 });

  // A spy over the REAL ledger, not a stub: the delegation keeps the port's
  // own accounting honest while the row reads what the port handed over.
  //
  // The property is read at the boundary rather than through the cap's refusal
  // because the two implementations differ only in an argument. Driving the cap
  // to refuse would mean holding calls in flight, and under the regression the
  // refusal never comes — the call hangs, the event loop stalls, and every
  // later test in this file is cancelled by the parent. A row that reports a
  // regression as somebody else's failure is worse than no row.
  const reserved = [];
  const ledger = { ...inner, reserve(perCall) { reserved.push(perCall); inner.reserve(perCall); } };

  const port = createReferenceModelPort({
    apiKey: fakeApiKey(),
    modelId: 'claude-under-test',
    ledger,
    async fetchImpl() {
      return completionResponse({ text: 'answer' });
    },
  });

  await port.complete({ system: 's', prompt: 'p', maxOutputTokens: 400 });

  assert.deepEqual(
    reserved,
    [400],
    "the port must hand the ledger the budget of the call it is about to make: a reservation with no estimate leaves the output-token cap seeing only what has already come back, and a concurrent caller passes it entirely — the defect the reservation counter beside it was added to fix",
  );
});

/* -------------------------------------------------------------------------- */
/* A truncated answer is the harness's doing, not the model's                  */
/* -------------------------------------------------------------------------- */

/**
 * 🔴 **The port ignored `stop_reason`, so a harness limit was reported as a
 * model-quality failure.**
 *
 * Anthropic returns `stop_reason: "max_tokens"` when it cuts a completion off at
 * the requested budget. The port read `text` and `usage` and nothing else, so a
 * truncated answer reached the role as an ordinary string, `JSON.parse` failed
 * on the half-written object, and the role reported "the answer is not
 * parseable JSON".
 *
 * That sentence is false, and falsely about the thing this lane exists to
 * measure. The model did not produce bad JSON — it was interrupted. Measured on
 * a real calibration run: the lane recorded the model arm unreportable for
 * producing malformed output, and the guard below removed the symptom.
 *
 * ⚠ An earlier version of this paragraph offered `outputTokens: 4132 against a
 * 4096 budget` as the evidence. That figure is real but CUMULATIVE across three
 * completions, so it says nothing about whether any single one hit the cap — a
 * claim one notch wider than the number behind it, which a cold review caught.
 *
 * This repository already refuses the two neighbouring versions of this mistake
 * — a missing measurement never becomes a zero, and a model run that did not
 * happen is never presented as model-quality evidence. A run that was CUT OFF
 * being presented as a model failure is the same error wearing a third face.
 */
test('carries the reason a completion stopped, so a truncation is not read as the model answering badly', async () => {
  const createReferenceModelPort = requireExport('createReferenceModelPort');
  const createModelUsageLedger = requireExport('createModelUsageLedger');

  const port = createReferenceModelPort({
    apiKey: 'test-key-not-a-real-credential',
    modelId: 'claude-under-test',
    ledger: createModelUsageLedger({ maxCalls: 4 }),
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{"assessments":[{"id":"a-1",' }],
          usage: { input_tokens: 10, output_tokens: 4096 },
          stop_reason: 'max_tokens',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  });

  const completion = await port.complete({
    system: 'irrelevant',
    prompt: 'irrelevant',
    maxOutputTokens: 4096,
  });

  assert.equal(
    completion.stopReason,
    'max_tokens',
    'the port must carry why the provider stopped: without it a truncation is indistinguishable from a model that wrote malformed JSON, and the lane reports the second when the first is true',
  );
});

/* -------------------------------------------------------------------------- */
/* The answer shape is constrained by the provider, not asked for in prose     */
/* -------------------------------------------------------------------------- */

/**
 * 🔴 **The roles asked for JSON in a sentence and hoped.**
 *
 * Every role's system prompt carries an "Answer shape:" line and a JSON-only
 * instruction, and then `parseJsonDocument` picks the first `{` to the last `}`
 * and hopes. Measured on real calibration runs, the reference model answered
 * with syntactically invalid JSON — `"rationale"::"placehol"`, a doubled colon —
 * and the whole lane recorded the model arm unreportable.
 *
 * The provider offers a mechanism that makes that impossible:
 * `output_config.format` with a JSON schema constrains the response itself.
 * Measured against the live API before this was written: the same request with
 * a schema came back as `{"answer":"hello"}` and `stop_reason: end_turn`.
 *
 * ⚠ **This is not tuning, and the distinction matters for a hold-out.** It does
 * not change what the model is asked to reason about, and it cannot make a bad
 * hypothesis good. It removes an ENCODING failure — whether the model can emit
 * well-formed JSON — from a lane that exists to measure investigation quality.
 * The roles still refuse a schema-valid answer whose CONTENT the domain rejects,
 * and those refusals remain the measurement.
 */
test('constrains the answer shape at the provider when a role declares one', async () => {
  const createReferenceModelPort = requireExport('createReferenceModelPort');
  const createModelUsageLedger = requireExport('createModelUsageLedger');
  let sentBody;

  const port = createReferenceModelPort({
    apiKey: 'test-key-not-a-real-credential',
    modelId: 'claude-under-test',
    ledger: createModelUsageLedger({ maxCalls: 4 }),
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{"ok":true}' }],
          usage: { input_tokens: 5, output_tokens: 5 },
          stop_reason: 'end_turn',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const schema = {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  };
  await port.complete({
    system: 'irrelevant',
    prompt: 'irrelevant',
    maxOutputTokens: 1024,
    outputSchema: schema,
  });

  assert.deepEqual(
    sentBody.output_config,
    { format: { type: 'json_schema', schema } },
    'a declared schema must reach the provider as output_config.format: asking for a shape in prose and parsing hopefully is what let a doubled colon end a thirty-record evaluation',
  );
});

test('sends no output_config when a role declares no shape', async () => {
  const createReferenceModelPort = requireExport('createReferenceModelPort');
  const createModelUsageLedger = requireExport('createModelUsageLedger');
  let sentBody;

  const port = createReferenceModelPort({
    apiKey: 'test-key-not-a-real-credential',
    modelId: 'claude-under-test',
    ledger: createModelUsageLedger({ maxCalls: 4 }),
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'free text' }],
          usage: { input_tokens: 5, output_tokens: 5 },
          stop_reason: 'end_turn',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  await port.complete({ system: 's', prompt: 'p', maxOutputTokens: 128 });

  assert.equal(
    Object.hasOwn(sentBody, 'output_config'),
    false,
    'an absent schema must send no output_config at all: an empty one is a constraint nobody declared',
  );
});

/**
 * 🔴 **The own-read on `outputSchema`, pinned.**
 *
 * A polluted `Object.prototype.outputSchema` would otherwise make every role
 * send a constraint no caller declared — and the provider would then enforce a
 * shape the run never chose, turning the answers into refusals attributed to the
 * model. The guard was correct when measured directly and demonstrated by
 * nothing: replacing `ownValue(request, 'outputSchema')` with
 * `request.outputSchema` left the suite at 911/911.
 *
 * Both sibling own-reads in this package carry a named row each; this one had a
 * comment making the claim and no test behind it, which `.claude/rules/invariants.md`
 * calls a guess rather than a check.
 */
test('reads the answer schema as an own property, never one the prototype supplied', async () => {
  const createReferenceModelPort = requireExport('createReferenceModelPort');
  const createModelUsageLedger = requireExport('createModelUsageLedger');
  let sentBody;

  const port = createReferenceModelPort({
    apiKey: 'test-key-not-a-real-credential',
    modelId: 'claude-under-test',
    ledger: createModelUsageLedger({ maxCalls: 4 }),
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{}' }],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const planted = { type: 'object', properties: {}, additionalProperties: false };
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(Object.prototype, 'outputSchema', {
    value: planted,
    configurable: true,
    writable: true,
  });
  try {
    await port.complete({ system: 's', prompt: 'p', maxOutputTokens: 64 });
  } finally {
    delete Object.prototype.outputSchema;
  }

  assert.equal(
    Object.hasOwn(sentBody, 'output_config'),
    false,
    'a schema reached through the prototype chain is a constraint nobody declared: sending it would have the provider enforce a shape the run never chose, and the refusals that followed would be recorded against the model',
  );
});

/**
 * 🔴 The cap counted CALLS, so raising the per-call token budget raised the
 * worst case with nothing to stop it.
 *
 * `DEFAULT_MAX_OUTPUT_TOKENS` went 4096 → 16000 at the AIC-19 gate for a real
 * reason — the reference model was being cut off and the record blamed it — but
 * both `security-scanner` and `code-reviewer` observed the same consequence
 * independently: worst-case output spend for one hold-out went from about 614k
 * to 2.4M tokens, and the only bound in the system counts calls. A cap that does
 * not track the quantity being raised is not a cap on it.
 *
 * The token cap refuses the NEXT reservation once the budget is spent, rather
 * than trying to refuse mid-flight: a completion already in the air has been
 * billed whatever it returns, and pretending otherwise would understate spend.
 */
test('stops reserving once the declared output-token budget is spent, not only once the calls are', async () => {
  const { createModelUsageLedger } = await import('@aic/roles');

  const ledger = createModelUsageLedger({ maxCalls: 100, maxOutputTokens: 1000 });

  ledger.reserve();
  ledger.record({ inputTokens: 10, outputTokens: 600 });
  ledger.reserve();
  ledger.record({ inputTokens: 10, outputTokens: 500 });

  assert.equal(ledger.read().outputTokens, 1100);
  assert.throws(
    () => ledger.reserve(),
    /token/i,
    'the ledger must refuse the next reservation once the output-token budget is spent, and say so in terms of tokens rather than calls',
  );
});

test('leaves a ledger with no declared token budget bounded by calls alone, so existing callers are unchanged', async () => {
  const { createModelUsageLedger } = await import('@aic/roles');

  const ledger = createModelUsageLedger({ maxCalls: 2 });
  ledger.reserve();
  ledger.record({ inputTokens: 10, outputTokens: 10_000_000 });

  assert.doesNotThrow(
    () => ledger.reserve(),
    'an absent token budget must mean no token bound at all: a missing measurement never becomes a zero, and a default cap here would refuse honest runs nobody asked to bound',
  );
});

/**
 * 🔴 The token cap under CONCURRENCY, which the first version got wrong in the
 * one way this file argues against eleven lines above the check.
 *
 * `reserve()` read `outputTokens`, which only `record()` advances — so N in-flight
 * reservations all saw the same total and all passed. Measured by
 * `security-scanner` and `code-reviewer` independently: 50 reservations granted
 * against a 1000-token cap with zero recorded. That is exactly the shape the
 * `reserved` counter beside it was added to fix, under a comment reading "a cap
 * whose correctness depends on how its caller happens to loop is not a cap" — so
 * the fix is the same shape, not a precondition written in prose.
 *
 * `reserve` now takes the per-call budget the caller is about to spend and
 * accounts for it pessimistically; `record` reconciles the estimate against what
 * the completion actually cost.
 */
test('bounds output tokens across concurrent reservations, not only after they are recorded', async () => {
  const { createModelUsageLedger } = await import('@aic/roles');

  const ledger = createModelUsageLedger({ maxCalls: 50, maxOutputTokens: 1000 });

  // Every reservation taken BEFORE any completion comes back, which is what a
  // concurrent caller does and what the previous check could not see.
  let granted = 0;
  for (let index = 0; index < 50; index += 1) {
    try {
      ledger.reserve(400);
      granted += 1;
    } catch {
      break;
    }
  }

  assert.ok(
    granted < 50,
    `a declared per-call budget must bound concurrent reservations: 400 tokens each against a 1000-token cap cannot grant 50 (granted ${granted})`,
  );
  assert.equal(
    granted,
    2,
    'two reservations of 400 fit under a 1000-token budget and the third does not: the bound is on what is committed, not on what has come back',
  );
});

test('reconciles a pessimistic reservation against what the completion actually cost', async () => {
  const { createModelUsageLedger } = await import('@aic/roles');

  const ledger = createModelUsageLedger({ maxCalls: 50, maxOutputTokens: 1000 });

  // Reserved at the budget, spent far under it: the headroom must come back, or
  // a cap sized on budgets rather than on spend would refuse honest runs.
  ledger.reserve(400);
  ledger.record({ inputTokens: 10, outputTokens: 10 });
  ledger.reserve(400);
  ledger.record({ inputTokens: 10, outputTokens: 10 });
  ledger.reserve(400);
  ledger.record({ inputTokens: 10, outputTokens: 10 });

  assert.equal(ledger.read().outputTokens, 30);
  assert.doesNotThrow(
    () => ledger.reserve(400),
    'three completions costing 10 tokens each must not exhaust a 1000-token budget: the reservation is an estimate, and recording replaces it',
  );
});

test('refuses a usage record that would drive the accumulator backwards', async () => {
  const { createModelUsageLedger } = await import('@aic/roles');

  const ledger = createModelUsageLedger({ maxCalls: 4, maxOutputTokens: 100 });
  ledger.reserve();

  assert.throws(
    () => ledger.record({ inputTokens: 0, outputTokens: -100_000 }),
    /non-negative/,
    'a negative usage count must be refused: it drives the accumulator below zero and disables the token bound permanently',
  );
});

/**
 * 🔴 A per-call budget that is PRESENT and unreadable is a refusal, not an
 * absence — the distinction `.claude/rules/invariants.md` marks in red as the
 * one that costs a credential when it is got backwards.
 *
 * The first version of `reserve` collapsed them: absent meant zero, and so did
 * `1.5`, `NaN`, `Infinity`, `1e30`, `'16000'` and `null`. Measured by
 * `security-scanner` at the AIC-19 gate — fifty grants against a 1000-token cap,
 * the bound silently off, while the same unreadable value travelled to the
 * provider as `max_tokens`. Both neighbours in this file already got it right:
 * the constructor throws on an invalid cap and `record` throws on an invalid
 * count.
 */
test('refuses a per-call budget it was handed and cannot read, rather than treating it as none', async () => {
  const { createModelUsageLedger } = await import('@aic/roles');

  for (const unreadable of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e30, '16000', null, -1]) {
    const ledger = createModelUsageLedger({ maxCalls: 50, maxOutputTokens: 1000 });
    assert.throws(
      () => ledger.reserve(unreadable),
      /cannot read|non-negative/,
      `reserve(${String(unreadable)}) must be refused: it was HANDED a budget and could not read it, which is not the same as being handed none`,
    );
  }

  // Absent stays fail-open, deliberately: nothing was handed, so there is
  // nothing to judge, and a caller that declares no budget is bounded by calls.
  const ledger = createModelUsageLedger({ maxCalls: 50, maxOutputTokens: 1000 });
  assert.doesNotThrow(
    () => ledger.reserve(),
    'an ABSENT budget is the fail-open case: the ledger was handed nothing to judge',
  );
});

/**
 * A reservation whose call never completes is never retired — stated here
 * because the comment beside the check once claimed the opposite.
 *
 * The port reserves, then every throw after it — a non-ok response, a missing
 * text block, an unreadable usage count — skips `record`. The estimate is
 * stranded permanently. That is the SAFE direction (the bound refuses early,
 * never late) but "record gives the headroom back" was unconditionally false,
 * and the path had no test. Found by `code-reviewer` at the AIC-19 gate.
 */
test('strands the estimate of a call that never completed, refusing early rather than late', async () => {
  const { createModelUsageLedger } = await import('@aic/roles');

  const ledger = createModelUsageLedger({ maxCalls: 50, maxOutputTokens: 1000 });
  ledger.reserve(400); // the provider throws; no record follows
  ledger.reserve(400); // likewise

  assert.equal(
    ledger.read().outputTokens,
    0,
    'nothing was recorded, so nothing was spent as far as this ledger can prove',
  );
  assert.throws(
    () => ledger.reserve(400),
    /reserved/,
    'two failed calls must still consume the budget they reserved: the ledger cannot know whether the provider billed them, and refusing early is the only safe reading',
  );
});

/**
 * A declared budget of ZERO is a budget of zero, not an absent one.
 *
 * `0 > 0` is false, so the first version granted reservations under a zero cap —
 * a config that reads as "spend nothing" and permitted everything. Flagged by
 * both `security-scanner` and `code-reviewer` at the AIC-19 gate as unreachable
 * today and a surprising reading of `0`. Absent still means unbounded; that
 * distinction is the point.
 */
test('treats a declared output-token cap of zero as zero, not as no cap at all', async () => {
  const { createModelUsageLedger } = await import('@aic/roles');

  const zero = createModelUsageLedger({ maxCalls: 5, maxOutputTokens: 0 });
  assert.throws(
    () => zero.reserve(1),
    /budget/,
    'a zero budget must refuse a call that declares a cost',
  );
  // The case the scanners actually found: with NO declared per-call budget the
  // arithmetic was `0 + 0 + 0 > 0`, which is false, so the call went through a
  // cap that reads as forbidding every call.
  assert.throws(
    () => createModelUsageLedger({ maxCalls: 5, maxOutputTokens: 0 }).reserve(),
    /budget/,
    'a zero budget must refuse a call that declares nothing either: zero is a number somebody wrote down, and only ABSENT means unbounded',
  );

  const absent = createModelUsageLedger({ maxCalls: 5 });
  assert.doesNotThrow(
    () => absent.reserve(1_000_000),
    'an ABSENT cap is still unbounded: nothing was declared, so there is nothing to judge',
  );
});

/**
 * The limit the ledger's own comment states, pinned — because a limits comment
 * with nothing behind it is the thing `.claude/rules/invariants.md` calls a
 * guard's claim about how far it can be trusted, and prose drifts.
 *
 * `record` retires the OLDEST outstanding estimate, whoever reserved it. So a
 * caller that records without reserving frees another call's headroom. The port
 * reserves and records in pairs, sequentially, which is what makes the
 * accounting exact in production — but the hole is real and this row is the
 * proof, reproduced from `code-reviewer`'s measurement at the AIC-19 gate.
 */
test('lets an unpaired record free another reservation headroom, which is the limit its comment states', async () => {
  const { createModelUsageLedger } = await import('@aic/roles');

  const ledger = createModelUsageLedger({ maxCalls: 50, maxOutputTokens: 1000 });
  ledger.reserve(500);
  ledger.reserve(500);
  assert.throws(() => ledger.reserve(500), /budget/, 'the cap is fully committed');

  ledger.record({ inputTokens: 0, outputTokens: 10 }); // no matching reserve

  assert.doesNotThrow(
    () => ledger.reserve(480),
    'this is the documented hole: the unpaired record retired one of the in-flight estimates, so a third call is admitted — 10 recorded plus three budgets of 500, 500 and 480 is 1,490 against a 1,000 cap',
  );
});

/**
 * ⚠ The ledger bounds CALLS and OUTPUT tokens. It does not bound input tokens,
 * and this repository's own spend is the larger half on that axis — 622,792
 * input against 243,028 output across every committed record.
 *
 * Stated and pinned rather than left for a reader to infer from an absence,
 * because the framing around the caps is "the call cap does not bound spend",
 * and someone reading that could reasonably assume the gap was closed on every
 * axis. Raised by `code-reviewer` at the AIC-19 gate.
 */
test('bounds calls and output tokens, and does not bound input tokens', async () => {
  const { createModelUsageLedger } = await import('@aic/roles');

  const ledger = createModelUsageLedger({ maxCalls: 5, maxOutputTokens: 1000 });
  ledger.reserve(1);
  ledger.record({ inputTokens: 10_000_000, outputTokens: 1 });

  assert.equal(ledger.read().inputTokens, 10_000_000);
  assert.doesNotThrow(
    () => ledger.reserve(1),
    'there is no input-token bound: a caller that needs one has to add it, and nothing here should be read as providing it',
  );
});
