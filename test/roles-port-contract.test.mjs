/**
 * AIC-94, step 1: the reference-model port and its configuration.
 *
 * The acceptance criterion this file pins is the one that is decidable without a
 * provider credential and without a network: an environment that carries no key
 * must produce a NAMED refusal rather than a silently disabled lane. Everything
 * else in the model path is unreachable here — see the run report — so the
 * refusal is the part that has to be mechanical.
 *
 * The environment is an ARGUMENT everywhere in this file, never `process.env`:
 * `packages/` reads the process environment zero times, which is what makes
 * `resolveTracingConfig` in `packages/observability` decidable in a test, and the
 * model configuration follows the same convention.
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
