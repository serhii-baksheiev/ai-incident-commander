/**
 * AIC-94, step 1: the reference-model port and its configuration.
 *
 * The acceptance criterion this file pins is the one that is decidable without a
 * provider credential and without a network: an environment that carries no key
 * must produce a NAMED refusal rather than a silently disabled lane. Everything
 * else in the model path is unreachable here — see the run report — so the
 * refusal is the part that has to be mechanical.
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

  assert.deepEqual(completion, {
    text: '{"ok":true}',
    modelId: 'claude-under-test',
    usage: { inputTokens: 12, outputTokens: 4 },
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
