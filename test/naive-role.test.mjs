/**
 * AIC-115 (v0.2 evidence repair, slice 1): a NAIVE single-prompt model role.
 *
 * This is the lower baseline the v0.2 evidence repair needs: one prompt, one
 * completion, over the SAME telemetry the graph roles read, so a later
 * comparison can ask "does the graph make the same model better than one
 * prompt" instead of comparing two different inputs.
 *
 * Every assertion here runs against a FAKE port, exactly like
 * `roles-model-nodes.test.mjs`. The role is written to `ModelPort`, which
 * names no provider, so the whole thing is decidable with no network and no
 * credential. Nothing here is a claim about model QUALITY: it pins the
 * contract the naive role must satisfy whatever the model answers — every
 * value that claims to point at shown evidence or a declared hypothesis is
 * checked, and a schema-valid but self-contradictory answer (an
 * 'inconclusive' conclusion carrying a cause, two causes under 'root-cause',
 * a mechanism outside the vocabulary the caller supplied) is refused rather
 * than passed through.
 *
 * The dependency-cruiser rows pin that this role cannot reach the graph, by
 * a direct import or through a module it imports, and that the refusal comes
 * from the naive-role rule itself rather than from some broader rule beside it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { EvidenceAssessmentSchema, IncidentConclusionSchema } from '@aic/domain';
import * as roles from '@aic/roles';

import { childEnv } from './fixtures/child-env.mjs';
import { withPollutedObjectPrototype } from './fixtures/prototype-decoy.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function requireExport(name) {
  assert.ok(roles[name] !== undefined, `@aic/roles must export ${name}`);
  return roles[name];
}

/**
 * A port that answers with a scripted body and records what it was asked, in
 * the same shape `roles-model-nodes.test.mjs`'s `fakePort` uses. `answers` is
 * consumed in order, so a test expecting one call fails loudly on a second
 * rather than replaying the last answer forever — which is exactly the shape
 * that would hide a retry.
 */
function fakePort(answers) {
  const requests = [];
  const remaining = [...answers];
  return {
    requests,
    port: {
      async complete(request) {
        requests.push(request);
        const next = remaining.shift();
        assert.ok(next !== undefined, 'the fake port ran out of scripted answers: an extra call means a retry');
        return {
          text: typeof next === 'string' ? next : JSON.stringify(next),
          modelId: 'claude-under-test',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    },
  };
}

/** The closed root-cause mechanism vocabulary this suite exercises with. */
const MECHANISMS = Object.freeze(['config-drift', 'capacity-exhaustion']);

const INCIDENT_ID = 'incident-naive-1';

/**
 * The telemetry the naive role reads, one entry of each status the input
 * shape declares. Kept as a function so a test that mutates one entry never
 * bleeds into another.
 */
function sampleEntries() {
  return [
    {
      status: 'ok',
      tool: 'query-logs',
      input: { service: 'checkout-logs-svc' },
      evidence: [
        {
          id: 'evidence-1',
          kind: 'deploy',
          source: 'deploy-log',
          observedAt: '2026-01-01T00:00:00.000Z',
          statement: 'checkout-v42 rolled out at 00:00',
        },
      ],
    },
    {
      status: 'unavailable',
      tool: 'query-metrics',
      input: { service: 'checkout-metrics-svc', metric: 'latency-p99' },
      reason: 'the metrics backend was disabled for this environment',
    },
    {
      status: 'error',
      tool: 'query-traces',
      input: { service: 'checkout-traces-svc' },
      message: 'the trace backend returned an internal error',
    },
  ];
}

/** A schema-valid, internally-consistent answer: every refusal test mutates one field off this. */
function baseAnswer() {
  return {
    hypotheses: [{ id: 'h-1', statement: 'the checkout deploy introduced a config drift' }],
    assessments: [{ evidenceId: 'evidence-1', hypothesisId: 'h-1', effect: 'supports' }],
    conclusion: {
      kind: 'root-cause',
      causes: [
        {
          hypothesisId: 'h-1',
          cause: { component: 'checkout-service', mechanism: 'config-drift' },
          evidenceIds: ['evidence-1'],
        },
      ],
    },
    stopKind: 'sufficient',
  };
}

function makeNode(overrides) {
  const createModelNaiveInvestigation = requireExport('createModelNaiveInvestigation');
  return createModelNaiveInvestigation({ mechanisms: MECHANISMS, ...overrides });
}

/* -------------------------------------------------------------------------- */
/* The exported constants                                                     */
/* -------------------------------------------------------------------------- */

test('exports the naive prompt version as the literal a caller can pin a record to', () => {
  const NAIVE_PROMPT_VERSION = requireExport('NAIVE_PROMPT_VERSION');
  assert.equal(NAIVE_PROMPT_VERSION, 'naive-single-prompt-v0.1');
});

test('exports NAIVE_STOP_KINDS as exactly the stop kinds one call can produce, frozen', () => {
  const NAIVE_STOP_KINDS = requireExport('NAIVE_STOP_KINDS');
  assert.deepEqual(
    [...NAIVE_STOP_KINDS],
    ['sufficient', 'ambiguous', 'stalled', 'tools-unavailable'],
    "budget-exhausted and human-stop are graph-lifecycle stop kinds: a single call has no budget loop and no human in it, so it cannot legitimately produce either",
  );
  assert.ok(
    Object.isFrozen(NAIVE_STOP_KINDS),
    'NAIVE_STOP_KINDS must be frozen so a caller cannot widen the vocabulary by mutating the export in place',
  );
});

/* -------------------------------------------------------------------------- */
/* Exactly one completion per invocation                                      */
/* -------------------------------------------------------------------------- */

test('calls the port exactly once for a valid answer', async () => {
  const { port, requests } = fakePort([baseAnswer()]);
  const node = makeNode({ port });

  await node({ incidentId: INCIDENT_ID, entries: sampleEntries() });

  assert.equal(requests.length, 1);
});

test('does not retry when the answer is refused: the port is still called exactly once', async () => {
  const refused = baseAnswer();
  refused.stopKind = 'budget-exhausted'; // outside NAIVE_STOP_KINDS
  const { port, requests } = fakePort([refused]);
  const node = makeNode({ port });

  await assert.rejects(() => node({ incidentId: INCIDENT_ID, entries: sampleEntries() }));

  assert.equal(
    requests.length,
    1,
    'a refused answer must not trigger a second, repair-seeking call: that would hide the model-quality signal this baseline measures',
  );
});

/* -------------------------------------------------------------------------- */
/* The prompt shows every entry, and only what the caller passed              */
/* -------------------------------------------------------------------------- */

test('shows the model the incident id and every entry — ok, unavailable and error alike — in the given order', async () => {
  const { port, requests } = fakePort([baseAnswer()]);
  const node = makeNode({ port });

  await node({ incidentId: INCIDENT_ID, entries: sampleEntries() });

  assert.equal(requests.length, 1);
  const prompt = requests[0].prompt;

  const markers = [
    INCIDENT_ID,
    // entry 1 (ok): every evidence field
    'evidence-1',
    'deploy',
    'deploy-log',
    '2026-01-01T00:00:00.000Z',
    'checkout-v42 rolled out at 00:00',
    // entry 2 (unavailable): tool, input, reason
    'query-metrics',
    'checkout-metrics-svc',
    'the metrics backend was disabled for this environment',
    // entry 3 (error): tool, input, message
    'query-traces',
    'checkout-traces-svc',
    'the trace backend returned an internal error',
  ];

  let previousIndex = -1;
  for (const marker of markers) {
    const index = prompt.indexOf(marker);
    assert.ok(index >= 0, `the prompt must carry ${JSON.stringify(marker)}: ${prompt}`);
    assert.ok(
      index > previousIndex,
      `${JSON.stringify(marker)} must appear after the previous marker, in entry order: ${prompt}`,
    );
    previousIndex = index;
  }
});

test('shows only the five named evidence fields, never an extra field the caller placed on an evidence object', async () => {
  const entries = sampleEntries();
  // A sentinel the naive input shape never declares (evidence has exactly
  // id/kind/source/observedAt/statement) but nothing at the JS level stops a
  // caller from attaching one anyway.
  entries[0].evidence[0].rawRef = 'trial-should-not-reach-the-prompt-42';
  entries[0].evidence[0].trialId = 'trial-should-not-reach-the-prompt-43';

  const { port, requests } = fakePort([baseAnswer()]);
  const node = makeNode({ port });

  await node({ incidentId: INCIDENT_ID, entries });

  assert.equal(requests.length, 1);
  assert.doesNotMatch(
    requests[0].prompt,
    /trial-should-not-reach-the-prompt-42|trial-should-not-reach-the-prompt-43/,
    'the naive role must read only the five named evidence fields off an evidence object, not serialize whatever the caller happened to attach',
  );
});

/* -------------------------------------------------------------------------- */
/* The provider-enforced output schema                                        */
/* -------------------------------------------------------------------------- */

/** Capture the outputSchema a call declared, without needing a real answer. */
async function captureOutputSchema(overrides) {
  const captured = [];
  const capturingPort = {
    async complete(request) {
      captured.push(request);
      throw new Error('stop here: this test reads the request, not the answer');
    },
  };
  const node = makeNode({ port: capturingPort, ...overrides });
  await assert.rejects(() => node({ incidentId: INCIDENT_ID, entries: sampleEntries() }));
  return captured[0];
}

function assertClosedObjectSchema(node, path) {
  if (node === null || typeof node !== 'object') return;
  if (node.type === 'object') {
    assert.equal(
      node.additionalProperties,
      false,
      `schema node at ${path} is an object schema without additionalProperties: false`,
    );
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const [key, child] of Object.entries(node.properties)) {
      assertClosedObjectSchema(child, `${path}.properties.${key}`);
    }
  }
  if (node.items) {
    assertClosedObjectSchema(node.items, `${path}.items`);
  }
}

test('declares an output schema that is closed at every object level', async () => {
  const request = await captureOutputSchema();
  assert.ok(request.outputSchema, 'the naive role must declare an output schema for the provider to enforce');
  assertClosedObjectSchema(request.outputSchema, 'outputSchema');
});

test('derives the assessment effect enum, conclusion kind enum and stopKind enum rather than restating them', async () => {
  const request = await captureOutputSchema();
  const schema = request.outputSchema;

  assert.deepEqual(
    schema.properties.assessments.items.properties.effect.enum,
    EvidenceAssessmentSchema.shape.effect.options,
    'the effect vocabulary must come from the domain, the same rule the existing roles already follow (a hand-written copy went wrong within an hour once)',
  );
  assert.deepEqual(
    schema.properties.conclusion.properties.kind.enum,
    IncidentConclusionSchema.shape.kind.options,
    'the conclusion kind vocabulary must come from the domain',
  );
  assert.deepEqual(
    schema.properties.stopKind.enum,
    [...requireExport('NAIVE_STOP_KINDS')],
    "the schema's stopKind enum must equal NAIVE_STOP_KINDS exactly, not restate it",
  );
});

test('derives the cause mechanism enum from exactly the mechanisms vocabulary the caller supplied', async () => {
  const customMechanisms = ['custom-mechanism-alpha', 'custom-mechanism-beta'];
  const request = await captureOutputSchema({ mechanisms: customMechanisms });
  const schema = request.outputSchema;

  assert.deepEqual(
    schema.properties.conclusion.properties.causes.items.properties.cause.properties.mechanism.enum,
    customMechanisms,
    'roles must not import @aic/evals for a mechanism vocabulary: the caller supplies it, and the schema must reflect exactly what was supplied',
  );
});

/* -------------------------------------------------------------------------- */
/* The token budget and the rejected sampling parameter                       */
/* -------------------------------------------------------------------------- */

test('sends the exported DEFAULT_MAX_OUTPUT_TOKENS as maxOutputTokens by default', async () => {
  const DEFAULT_MAX_OUTPUT_TOKENS = requireExport('DEFAULT_MAX_OUTPUT_TOKENS');
  const { port, requests } = fakePort([baseAnswer()]);
  const node = makeNode({ port });

  await node({ incidentId: INCIDENT_ID, entries: sampleEntries() });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].maxOutputTokens,
    DEFAULT_MAX_OUTPUT_TOKENS,
    'the naive role must send the same output budget as the exported DEFAULT_MAX_OUTPUT_TOKENS',
  );
});

test('sends no temperature field, so the naive arm samples exactly as the graph arm does', async () => {
  const { port, requests } = fakePort([baseAnswer()]);
  const node = makeNode({ port });

  await node({ incidentId: INCIDENT_ID, entries: sampleEntries() });

  assert.equal(requests.length, 1);
  assert.equal(
    Object.hasOwn(requests[0], 'temperature'),
    false,
    'the request object must carry no own temperature property',
  );
});

/* -------------------------------------------------------------------------- */
/* A valid answer, parsed                                                     */
/* -------------------------------------------------------------------------- */

test('returns a parsed answer: hypotheses, assessments, a domain-parsed conclusion, and the stopKind', async () => {
  const answer = baseAnswer();
  const { port } = fakePort([answer]);
  const node = makeNode({ port });

  const result = await node({ incidentId: INCIDENT_ID, entries: sampleEntries() });

  assert.deepEqual(result.hypotheses, answer.hypotheses);
  assert.deepEqual(result.assessments, answer.assessments);
  assert.deepEqual(result.conclusion, IncidentConclusionSchema.parse(answer.conclusion));
  assert.equal(result.stopKind, answer.stopKind);
});

/* -------------------------------------------------------------------------- */
/* Deterministic refusals — each a ModelRoleOutputError naming the role       */
/* -------------------------------------------------------------------------- */

async function assertRefused(answer, messagePattern, description) {
  const { port, requests } = fakePort([answer]);
  const node = makeNode({ port });
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');

  await assert.rejects(
    () => node({ incidentId: INCIDENT_ID, entries: sampleEntries() }),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError, `${description}: refusal must be a ModelRoleOutputError, got ${error}`);
      assert.equal(error.role, 'naive_investigation', `${description}: the refusal must name the naive role`);
      if (messagePattern) {
        assert.match(error.message, messagePattern, `${description}: ${error.message}`);
      }
      return true;
    },
    description,
  );
  assert.equal(requests.length, 1, `${description}: a refusal must still be exactly one call`);
}

test('refuses an assessment whose effect is outside the domain effect vocabulary', async () => {
  const answer = baseAnswer();
  answer.assessments = [{ evidenceId: 'evidence-1', hypothesisId: 'h-1', effect: 'confirms' }];
  await assertRefused(answer, /effect/i, 'an assessment effect must be one the domain declares');
});

test('refuses a hypothesis with an empty id', async () => {
  const answer = baseAnswer();
  answer.hypotheses = [{ id: '', statement: 'an anonymous hypothesis' }, ...answer.hypotheses];
  await assertRefused(answer, /id/i, 'every hypothesis must carry a non-empty id');
});

test('refuses an unknown key on the conclusion, on a cause, and on a cause description', async () => {
  const onConclusion = baseAnswer();
  onConclusion.conclusion.confidence = 0.9;
  await assertRefused(onConclusion, /confidence/, 'an unknown key on the conclusion must be refused, not dropped');

  const onCause = baseAnswer();
  onCause.conclusion.causes[0].weight = 1;
  await assertRefused(onCause, /weight/, 'an unknown key on a cause must be refused, not dropped');

  const onDescription = baseAnswer();
  onDescription.conclusion.causes[0].cause.severity = 'high';
  await assertRefused(onDescription, /severity/, 'an unknown key on a cause description must be refused, not dropped');
});

test('names unknown keys escaped and capped, so a hostile key cannot shape the refusal message', async () => {
  const answer = baseAnswer();
  answer.conclusion['line-one\nline-two'] = 1;
  for (let index = 0; index < 50; index += 1) answer.conclusion[`extra-${index}`] = index;
  const { port } = fakePort([answer]);
  const node = makeNode({ port });
  await assert.rejects(
    () => node({ incidentId: INCIDENT_ID, entries: sampleEntries() }),
    (error) => {
      assert.doesNotMatch(error.message, /line-one\nline-two/, 'a raw newline from a model-chosen key must not reach the message');
      assert.match(error.message, /line-one\\nline-two/, 'the key is named, escaped');
      assert.ok(error.message.length < 600, `the message must stay bounded however many keys the answer invents (${error.message.length})`);
      assert.match(error.message, /and \d+ more/, 'the cap must say how many keys it left out');
      return true;
    },
  );
});

test('reads the conclusion only from what the answer owns, never from Object.prototype', async () => {
  const withoutKind = baseAnswer();
  delete withoutKind.conclusion.kind;
  await withPollutedObjectPrototype('kind', 'root-cause', () =>
    assertRefused(withoutKind, null, 'an inherited kind must not stand in for the answer the model did not give'),
  );

  const { port } = fakePort([baseAnswer()]);
  const node = makeNode({ port });
  const answer = await withPollutedObjectPrototype('trigger', 'SMUGGLED', () =>
    node({ incidentId: INCIDENT_ID, entries: sampleEntries() }),
  );
  assert.equal(
    Object.hasOwn(answer.conclusion.causes[0].cause, 'trigger'),
    false,
    'a cause the model gave no trigger must not acquire one from the prototype',
  );
});

test('refuses an assessment naming an evidence id not among the shown evidence', async () => {
  const answer = baseAnswer();
  answer.assessments = [{ evidenceId: 'evidence-does-not-exist', hypothesisId: 'h-1', effect: 'supports' }];
  await assertRefused(answer, /evidence/i, 'an assessment must point at evidence the model was actually shown');
});

test("refuses an assessment naming a hypothesis id not among the answer's own hypotheses", async () => {
  const answer = baseAnswer();
  answer.assessments = [{ evidenceId: 'evidence-1', hypothesisId: 'h-does-not-exist', effect: 'supports' }];
  await assertRefused(answer, /hypothes/i, 'an assessment must point at a hypothesis the answer actually declared');
});

test("refuses a cause naming a hypothesis id not among the answer's own hypotheses", async () => {
  const answer = baseAnswer();
  answer.conclusion.causes[0].hypothesisId = 'h-does-not-exist';
  await assertRefused(answer, /hypothes/i, 'a cause must point at a declared hypothesis');
});

test('refuses a cause naming an evidence id not among the shown evidence', async () => {
  const answer = baseAnswer();
  answer.conclusion.causes[0].evidenceIds = ['evidence-does-not-exist'];
  await assertRefused(answer, /evidence/i, 'a cause must point at evidence the model was actually shown');
});

test("refuses a 'no-incident' conclusion that still names a cause", async () => {
  const answer = baseAnswer();
  answer.conclusion.kind = 'no-incident';
  // causes carried over from baseAnswer() — a non-empty list contradicting "no incident"
  await assertRefused(answer, /no-incident/i, "'no-incident' must carry no cause");
});

test("refuses an 'inconclusive' conclusion that still names a cause", async () => {
  const answer = baseAnswer();
  answer.conclusion.kind = 'inconclusive';
  await assertRefused(answer, /inconclusive/i, "'inconclusive' must carry no cause");
});

test("refuses a 'root-cause' conclusion naming zero causes", async () => {
  const answer = baseAnswer();
  answer.conclusion.causes = [];
  await assertRefused(answer, /root-cause/i, "'root-cause' must name exactly one cause");
});

test("refuses a 'root-cause' conclusion naming two causes", async () => {
  const answer = baseAnswer();
  answer.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy introduced a config drift' },
    { id: 'h-2', statement: 'the connection pool was undersized' },
  ];
  answer.conclusion.causes = [
    { hypothesisId: 'h-1', cause: { component: 'checkout-service', mechanism: 'config-drift' }, evidenceIds: ['evidence-1'] },
    { hypothesisId: 'h-2', cause: { component: 'checkout-service', mechanism: 'capacity-exhaustion' }, evidenceIds: ['evidence-1'] },
  ];
  await assertRefused(answer, /root-cause/i, "'root-cause' must name exactly one cause, not two");
});

test("refuses a 'multiple-causes' conclusion naming exactly one cause", async () => {
  const answer = baseAnswer();
  answer.conclusion.kind = 'multiple-causes';
  // causes carried over from baseAnswer(): exactly one, which contradicts "multiple"
  await assertRefused(answer, /multiple-causes/i, "'multiple-causes' must name at least two causes");
});

test('refuses a stopKind outside NAIVE_STOP_KINDS, such as a graph-lifecycle stop kind', async () => {
  const answer = baseAnswer();
  answer.stopKind = 'budget-exhausted';
  await assertRefused(answer, /stopKind|stop kind/i, 'a single call cannot legitimately produce budget-exhausted or human-stop');
});

test('refuses a cause mechanism outside the supplied vocabulary', async () => {
  const answer = baseAnswer();
  answer.conclusion.causes[0].cause.mechanism = 'not-in-the-supplied-vocabulary';
  await assertRefused(answer, /mechanism/i, 'a cause mechanism outside the supplied vocabulary must be refused, not passed through');
});

test('refuses duplicate hypothesis ids', async () => {
  const answer = baseAnswer();
  answer.hypotheses = [
    { id: 'h-1', statement: 'the checkout deploy introduced a config drift' },
    { id: 'h-1', statement: 'a different statement under the same id' },
  ];
  await assertRefused(answer, /hypothes/i, 'two hypotheses sharing one id is not a coherent answer');
});

test('refuses a truncated completion as a truncation, not as malformed output', async () => {
  const truncating = {
    async complete() {
      return {
        text: '{"hypotheses":[{"id":"h-1",',
        modelId: 'claude-under-test',
        usage: { inputTokens: 10, outputTokens: 4096 },
        stopReason: 'max_tokens',
      };
    },
  };
  const node = makeNode({ port: truncating });
  const ModelRoleOutputError = requireExport('ModelRoleOutputError');

  await assert.rejects(
    () => node({ incidentId: INCIDENT_ID, entries: sampleEntries() }),
    (error) => {
      assert.ok(error instanceof ModelRoleOutputError);
      assert.equal(error.role, 'naive_investigation');
      assert.match(
        error.message,
        /truncat|max_tokens|token budget/i,
        `a cut-off answer must be reported as a truncation, the same wording family the graph roles use: ${error.message}`,
      );
      assert.doesNotMatch(
        error.message,
        /not parseable JSON/,
        `a truncated answer is the harness cutting the model off, not the model writing bad JSON: ${error.message}`,
      );
      return true;
    },
  );
});

/* -------------------------------------------------------------------------- */
/* The dependency boundary: naive-role.ts never imports the graph package     */
/* -------------------------------------------------------------------------- */

/**
 * Copies the worktree into a fresh `mktemp -d` directory, minus the heavy or
 * irrelevant top-level entries — the same shape
 * `test/durable-run-boundaries.test.mjs`'s `copyForBoundaryProbe` uses (see
 * that file's header, "how dependency-cruiser rules are tested in this
 * repo"). Duplicated rather than imported: that file exports nothing, and its
 * own sibling probes accept the same duplication.
 *
 * FILE-SAFETY: the copy and every mutation below live under this ONE
 * `mkdtempSync` directory, deleted in its own `finally` — nothing outside it
 * is ever touched.
 */
function copyForBoundaryProbe() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-naive-role-boundary-'));
  const fixtureRoot = join(temporaryRoot, 'repository');
  const excludedEntries = new Set([
    '.agents',
    '.claude',
    '.codex',
    '.git',
    '.github',
    'coverage',
    'node_modules',
  ]);

  cpSync(projectRoot, fixtureRoot, {
    recursive: true,
    filter(source) {
      const pathFromRoot = relative(projectRoot, source);
      return pathFromRoot === '' || !excludedEntries.has(pathFromRoot.split('/')[0]);
    },
  });

  const sourceNodeModules = resolve(projectRoot, 'node_modules');
  if (existsSync(sourceNodeModules)) {
    symlinkSync(sourceNodeModules, resolve(fixtureRoot, 'node_modules'), 'dir');
  }

  return { fixtureRoot, temporaryRoot };
}

function runNpm(args, cwd) {
  return spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    env: childEnv({ CI: '1' }),
  });
}

function commandDiagnostics(command, result) {
  return `${command} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

/**
 * Runs `npm run --silent lint:graph` against a fresh copy with `mutate`
 * applied, having first confirmed the UNMODIFIED copy passes — baseline
 * first, the same discipline `test/durable-run-boundaries.test.mjs` follows,
 * so a probe that fails for an unrelated reason is never read as "the rule
 * caught it".
 */
function runDepcruiseProbe(mutate) {
  const { fixtureRoot, temporaryRoot } = copyForBoundaryProbe();
  try {
    const baseline = runNpm(['run', '--silent', 'lint:graph'], fixtureRoot);
    assert.equal(
      baseline.status,
      0,
      `the unmodified scaffold must pass npm run lint:graph before a boundary probe is meaningful\n${commandDiagnostics('npm run lint:graph', baseline)}`,
    );

    mutate(fixtureRoot);
    return runNpm(['run', '--silent', 'lint:graph'], fixtureRoot);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

test('rejects packages/roles/src/naive-role.ts importing @aic/graph', () => {
  const result = runDepcruiseProbe((fixtureRoot) => {
    const path = resolve(fixtureRoot, 'packages/roles/src/naive-role.ts');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'import "@aic/graph";\nexport {};\n');
  });
  assert.notEqual(
    result.status,
    0,
    `npm run lint:graph accepted packages/roles/src/naive-role.ts importing @aic/graph: this is the lower baseline and must depend on no graph orchestration, even though other files in packages/roles legitimately do\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
  assert.match(
    result.stdout + result.stderr,
    /naive-role-does-not-import-the-graph/,
    `the refusal must come from the naive-role rule itself\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
});

test('rejects packages/roles/src/naive-role.ts importing packages/graph by relative path', () => {
  const result = runDepcruiseProbe((fixtureRoot) => {
    const path = resolve(fixtureRoot, 'packages/roles/src/naive-role.ts');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'import "../../graph/src/index.js";\nexport {};\n');
  });
  assert.notEqual(
    result.status,
    0,
    `npm run lint:graph accepted packages/roles/src/naive-role.ts importing packages/graph by relative path\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
  assert.match(
    result.stdout + result.stderr,
    /naive-role-does-not-import-the-graph/,
    `the refusal must come from the naive-role rule itself\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
});

test('rejects packages/roles/src/naive-role.ts reaching the graph through a module it imports', () => {
  const result = runDepcruiseProbe((fixtureRoot) => {
    const path = resolve(fixtureRoot, 'packages/roles/src/naive-role.ts');
    mkdirSync(dirname(path), { recursive: true });
    // investigation-roles.ts imports @aic/graph, so this edge reaches the graph
    // transitively without naming it.
    writeFileSync(path, 'import "./investigation-roles.js";\nexport {};\n');
  });
  assert.notEqual(
    result.status,
    0,
    `npm run lint:graph accepted packages/roles/src/naive-role.ts reaching the graph transitively\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
  assert.match(
    result.stdout + result.stderr,
    /naive-role-does-not-import-the-graph/,
    `the refusal must come from the naive-role rule itself\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
});
