/**
 * The command that owns the one shot, and the audit that keeps it the only one.
 *
 * The decision this command enforces is pure and lives in
 * `packages/evals/src/final-evaluation-record.ts`; these rows are about the
 * half that touches the disk and the half that cannot be expressed as a
 * function at all — that exactly one place in this repository reaches the
 * corpus.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LIVE_MODEL_LANE_MAX_MODEL_CALLS,
  LIVE_MODEL_LANE_MAX_OUTPUT_TOKENS,
  parseFinalEvaluationRecord,
  BEHAVIOR_METRIC_KEYS,
  BENCHMARK_METRIC_KEYS,
  LIVE_MODEL_LANE_WITHHELD_METRICS,
} from '@aic/evals';

import { childEnv } from './fixtures/child-env.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every tracked source file, minus the trees a corpus name legitimately lives in. */
function sourceFilesOutsideEvals() {
  // The allow-listed environment every spawn in this tree gets: a shadowed
  // `git` must not inherit the provider credential this branch's whole subject
  // depends on.
  const tracked = execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: childEnv(),
  })
    .split('\n')
    .filter(Boolean);
  return tracked.filter((path) => {
    if (path.startsWith('packages/evals/src/')) return false;
    if (path.startsWith('test/')) return false;
    if (path.startsWith('docs/')) return false;
    if (path.startsWith('.claude/')) return false;
    if (path.endsWith('.md')) return false;
    if (path.startsWith('dist/') || path.includes('/dist/')) return false;
    return /\.(mjs|ts|js|json)$/.test(path);
  });
}

/**
 * 🔴 **The row that keeps the door single.**
 *
 * `final-evaluation` is calibration ∪ hold-out, so any caller naming it spends
 * the one shot. Before this branch the shipped `eval:live-model` named it — as a
 * literal type with no alternative — and nothing said so; it had never spent the
 * corpus only because no provider credential existed, which is an accident of an
 * environment rather than a guard.
 *
 * A guard that protects one command while a second is free is theatre, and this
 * row is what makes the singleness checkable rather than remembered: a second
 * caller turns `npm run check` red instead of quietly spending the hold-out.
 *
 * ⚠ Its limit, stated: it reads TRACKED source. A scratch file, a `node -e`, or
 * an in-process caller importing `runGraphBenchmarkExperiment` directly is not
 * seen — `packages/evals/src/benchmark-evaluation.ts` will build that caller its
 * thirty records. This catches drift, not an operator who means it.
 */
test('reaches the final-evaluation corpus from exactly one command in this repository', () => {
  // ⚠ Comment lines are dropped before the scan, and that is a real limit
  // rather than a convenience: this repository's own prose discusses the corpus
  // by name — `eval-live-model.mjs`'s header records that it used to reach it —
  // and a scan that could not tell a sentence from a call would force the
  // explanation out of the file that most needs it. The cut is the crude one,
  // a line whose first non-space character opens or continues a comment, so a
  // call sharing a line with a trailing comment is still seen and a corpus name
  // built by concatenation is not.
  const codeLines = (path) =>
    readFileSync(join(REPO_ROOT, path), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
  const namers = sourceFilesOutsideEvals().filter((path) =>
    codeLines(path).includes("'final-evaluation'"),
  );

  assert.deepEqual(
    namers,
    ['scripts/eval-final-holdout.mjs'],
    `the final-evaluation corpus includes the hold-out, so every file that names it can spend the one shot. Found: ${namers.join(', ') || '(none)'}`,
  );
});

test('declares the one-shot command as an npm script, so it is invoked by name rather than by path', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

  assert.equal(
    typeof manifest.scripts['eval:final-holdout'],
    'string',
    'a command reachable only as a path is a command a reader has to know exists',
  );
  assert.match(
    manifest.scripts['eval:final-holdout'],
    /eval-final-holdout\.mjs/,
    'the script must run the guarded command and not some other entry point',
  );
});

test('keeps the evidence directory committed rather than ignored', () => {
  // A gitignored record is one `rm` away from a free and invisible re-run,
  // which is the whole property the record exists to carry. `git check-ignore`
  // exits 0 when a path IS ignored and 1 when it is not, so the refusal is the
  // pass and it is asserted rather than left to an uncaught throw.
  let ignored;
  try {
    execFileSync('git', ['check-ignore', '-q', 'docs/evidence/final-evaluation/README.md'], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
      env: childEnv(),
    });
    ignored = true;
  } catch {
    ignored = false;
  }

  assert.equal(
    ignored,
    false,
    'the evidence directory must be tracked: an ignored record can be removed with no diff, and then the next run is admitted with nothing to show that the previous one happened',
  );
});

test('states its limits beside the records, and every limit names something a reader can check', () => {
  const readme = readFileSync(
    join(REPO_ROOT, 'docs/evidence/final-evaluation/README.md'),
    'utf8',
  );

  for (const required of [
    'does not stop a re-run',
    'candidate fingerprint',
    'void',
  ]) {
    assert.ok(
      readme.includes(required),
      `the evidence README must state the limit naming "${required}": a mechanism whose limits are not written down is one a reader will assume covers more than it does`,
    );
  }
});

/**
 * 🔴 **An unconfigured run claimed the candidate and then refused, leaving a
 * record that asserted the opposite of what happened.**
 *
 * `resolveModelConfig` does not throw — it returns `{ available: false }` — so
 * reading it and moving on left the real refusal inside `runLiveModelLane`,
 * seven lines AFTER `claimRecord`. Measured under `env -i` with no credential:
 * the command wrote a `claimed` record and exited 1 having executed no scenario
 * and made no provider call. The next run was then refused with "the corpus is
 * spent when scenarios execute … so the runs happened" — false, over a run that
 * never started, and its only remedy a hand-written void record.
 *
 * The command's own header promised the opposite: "an unconfigured run creates
 * no dataset, no project, no run and no record."
 */
test('refuses an unconfigured run before it claims the candidate', () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts/eval-final-holdout.mjs'), 'utf8');

  // The CALL, not the definition: `function claimRecord(path, body)` appears
  // earlier in the file than `main()` does, and matching it made this row pass
  // for the wrong reason on its first draft.
  const availabilityCheck = source.indexOf('config.available !== true');
  const claim = source.indexOf('claimRecord(path, base)');

  assert.notEqual(availabilityCheck, -1, 'the command must CHECK availability, not merely resolve it: resolveModelConfig returns a value rather than throwing');
  assert.notEqual(claim, -1, 'the claim site must be findable for this row to mean anything');
  assert.equal(
    availabilityCheck < claim,
    true,
    'the credential refusal must come BEFORE the claim: a claim asserts that scenarios executed, and writing one for a run that never started makes the next refusal a false statement',
  );
});

/**
 * The documented safe invocation, checked against npm's own behaviour.
 *
 * `npm run <script> --dry-run` gives the flag to NPM, not to the script. The
 * evidence README said exactly that form while promising "without executing
 * anything", two lines from the correct one further down. A cold review measured
 * it taking the real path.
 */
test('documents the dry-run invocation in the form npm actually forwards', () => {
  const readme = readFileSync(
    join(REPO_ROOT, 'docs/evidence/final-evaluation/README.md'),
    'utf8',
  );

  // Only fenced blocks: those are the forms a reader COPIES. The prose above
  // them quotes the broken invocation deliberately, to say what it does, and a
  // scan that could not tell an instruction from a warning would force the
  // warning out of the file that most needs it.
  const fenced = [...readme.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
    .map(([, body]) => body)
    .join('\n');

  for (const match of fenced.matchAll(/npm run eval:final-holdout([^\n]*)/g)) {
    const tail = match[1];
    if (!tail.includes('--dry-run')) continue;
    assert.match(
      tail,
      /--\s+--dry-run/,
      `every documented dry-run invocation must pass the flag through npm with a bare --, or npm consumes it and the run takes the real path: found "npm run eval:final-holdout${tail}"`,
    );
  }
});

/**
 * 🔴 **A dry run claims nothing and calls nothing, so it needs nothing.**
 *
 * The credential check that stops an unconfigured run from claiming a candidate
 * was first placed ABOVE the `--dry-run` early return, which made the dry run
 * require a live provider key. Measured with `env -i`: the parent commit printed
 * the full decision JSON and the fixed one exited 1.
 *
 * That contradicted three sentences at once — the command's own header ("how a
 * reviewer verifies a record"), the evidence README's "without executing
 * anything", and its reproduction instruction for the fingerprint invariance —
 * and the refusal explained a claim the dry run was never going to make. The
 * row above pins that the check precedes the CLAIM; this one pins that it does
 * not precede the dry-run return, and both are needed because moving the block
 * either way leaves the other row green.
 */
test('reports a dry run with no provider credential, because a dry run claims nothing', () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts/eval-final-holdout.mjs'), 'utf8');

  const dryRunReturn = source.indexOf("if (flag('dry-run'))");
  const availabilityCheck = source.indexOf('config.available !== true');

  assert.notEqual(dryRunReturn, -1, 'the dry-run early return must be findable');
  assert.notEqual(availabilityCheck, -1, 'the availability check must be findable');
  assert.equal(
    dryRunReturn < availabilityCheck,
    true,
    'the dry run must return BEFORE the credential is required: it claims nothing and calls nothing, and the README sends a reviewer to it as the way to check a record without a credential and without spending a corpus',
  );
});

/**
 * 🔴 **Without a declared control baseline the hold-out could never satisfy
 * AIC-19, however well the model did.**
 *
 * `runLiveModelLane` refuses to call the model arm reportable when no baseline
 * is declared — a metric that moved could not be attributed to the model rather
 * than to the harness — and returns `verdict: 'control-baseline-undeclared'`.
 * The one-shot command passed none. Measured on a calibration run after the
 * encoding repair: the model arm COMPLETED all 24 examples and the verdict was
 * still `control-baseline-undeclared`, so a hold-out in that state would have
 * spent the one shot and produced an unreportable arm by construction.
 *
 * The baseline is a committed artifact rather than a value observed at run time:
 * observing it would make the harness-regression check compare a number against
 * itself.
 */
test('declares a control baseline for the hold-out, without which the model arm can never be reportable', () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts/eval-final-holdout.mjs'), 'utf8');
  const baseline = JSON.parse(
    readFileSync(join(REPO_ROOT, 'docs/evidence/control-baseline.json'), 'utf8'),
  );

  assert.equal(
    source.includes("join(EVIDENCE_DIR, 'control-baseline.json')"),
    false,
    'the baseline must not live inside the records directory: readRecords parses every .json there, so a baseline placed among the records refuses the whole run — measured on the first dry run after it was added',
  );
  assert.match(
    source,
    /controlBaseline/,
    'the command must pass a control baseline to the lane: without one the lane answers control-baseline-undeclared and the model arm is unreportable whatever it scored',
  );

  // Derived from the lane's own exported keys rather than written out here.
  // The hand-written pair this replaced asserted that the declared axes "must be
  // the ones the lane compares" while naming two of the five, so the row read as
  // covering the very gap it left open — the lane compared two axes and the
  // control arm emitted five.
  const compared = [...BENCHMARK_METRIC_KEYS, ...BEHAVIOR_METRIC_KEYS]
    .filter((key) => !Object.hasOwn(LIVE_MODEL_LANE_WITHHELD_METRICS, key))
    .sort();
  const declared = Object.keys(baseline).filter((key) => !key.startsWith('_'));
  assert.deepEqual(
    declared.sort(),
    compared,
    'the declared axes must be exactly the ones the lane compares: a missing axis is compared against nothing and can move without the lane noticing, and a withheld one pins a number nothing reads',
  );
  for (const key of declared) {
    assert.equal(
      typeof baseline[key],
      'number',
      `${key} must declare a number: a baseline that is not a value cannot be compared against one`,
    );
  }
});

/**
 * 🔴 The same defect as the credential's, one step later — and the file already
 * carried the fix for the earlier one when this was written.
 *
 * `readControlBaseline` throws on a missing, unreadable or non-JSON baseline. It
 * was first called while building the lane's argument object, which happens
 * AFTER `claimRecord`. So a broken baseline wrote a `claimed` record, threw, and
 * executed nothing — and `decideFinalEvaluation` then refuses that candidate
 * forever with "the corpus is spent when scenarios execute … so the runs
 * happened", which is false about a run that never started. `--dry-run` returns
 * before the lane is built, so the documented way to see every guard's verdict
 * without executing anything could not catch it either.
 *
 * Found by `code-reviewer` at the AIC-19 gate.
 */
test('reads the control baseline before it claims the candidate, because a broken baseline must not spend the one shot', () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts/eval-final-holdout.mjs'), 'utf8');

  // The CALL, not the declaration — `export function readControlBaseline(` sits
  // earlier in the file, and matching it made this assertion unfailable on its
  // first draft: `code-reviewer` proved it by moving the call below the claim
  // and watching only the OTHER assertion redden.
  const read = source.indexOf('const controlBaseline = readControlBaseline()');
  const claim = source.indexOf('claimRecord(path, base)');

  assert.notEqual(read, -1, 'the baseline read site must be findable for this row to mean anything');
  assert.notEqual(claim, -1, 'the claim site must be findable for this row to mean anything');
  assert.equal(
    read < claim,
    true,
    'the baseline must be READ before the claim: it throws on a missing or malformed file, and a claim written before it throws refuses the candidate forever with a reason that says the runs happened',
  );
  assert.equal(
    source.slice(claim).includes('readControlBaseline()'),
    false,
    'there must be no second read after the claim: one call above the claim does not help if the value is re-read below it',
  );
});

/**
 * An empty declaration is not a declaration, and `{}` walks past the guard that
 * exists to catch exactly that.
 *
 * The lane answers `control-baseline-undeclared` for `undefined`, which makes an
 * unreportable arm say so. But `readControlBaseline` returned `{}` for a file
 * that is empty, `_`-only, or a JSON array — and `{}` is not `undefined`, so the
 * lane accepted it, compared nothing, and would have called the model arm
 * reportable against a baseline pinning no axis at all. Probed at the AIC-19
 * gate: `declared: {}` returned verdict `model-quality`, `reportable: true`.
 */
test('refuses a control baseline that declares no axis at all, rather than passing an empty one to the lane', async () => {
  const { readControlBaseline } = await import('../scripts/eval-final-holdout.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'aic-baseline-'));

  try {
    for (const [name, body] of [
      ['empty.json', '{}'],
      ['rationale-only.json', '{"_why":"a note and nothing else"}'],
      ['array.json', '[]'],
    ]) {
      const path = join(dir, name);
      writeFileSync(path, body);
      assert.throws(
        () => readControlBaseline(path),
        /declares no axis/,
        `${name} declares no axis, and an empty object is not undefined — it passes the lane's control-baseline-undeclared guard while pinning nothing`,
      );
    }

    const good = join(dir, 'good.json');
    writeFileSync(good, '{"_why":"a note","unsupported_claim_rate":0}');
    assert.deepEqual(
      readControlBaseline(good),
      { unsupported_claim_rate: 0 },
      'a declaration with an axis must be returned with its `_`-prefixed rationale stripped',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 🔴 The placement claim, made mechanical.
 *
 * The row above asserts that one literal expression is absent from one caller.
 * The commit that added it said it "pins the placement so the next person
 * putting a helper file there learns it from a red test rather than from a
 * refused hold-out run" — which it does not: any other spelling of the path, or
 * any other helper file dropped into the records directory, leaves it green
 * while `readRecords` maps every `.json` there through
 * `parseFinalEvaluationRecord` and refuses the whole run.
 *
 * `prose-reviewer` and `code-reviewer` both took that sentence at the AIC-19
 * gate. This row checks the directory itself, so the sentence is now true.
 */
test('every .json beside the hold-out records is a hold-out record, because the reader parses all of them', () => {
  const dir = join(REPO_ROOT, 'docs/evidence/final-evaluation');
  const entries = readdirSync(dir).filter((name) => name.endsWith('.json'));

  assert.ok(
    entries.length > 0,
    'the records directory must hold records for this row to mean anything',
  );
  for (const name of entries) {
    const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    assert.doesNotThrow(
      () => parseFinalEvaluationRecord(parsed),
      `${name} sits among the hold-out records but is not one: readRecords parses every .json in this directory, so a helper file placed here refuses the next hold-out run entirely — put it beside the directory, not inside it`,
    );
  }
});

/**
 * A bound on one live path only is a bound on neither.
 *
 * Both commands that reach a provider build a usage ledger, and the ledger's
 * output-token cap is optional — absent means unbounded, deliberately. So the
 * cap exists in this repository only where a command asks for it, and this row
 * asserts that both of them do.
 */
test('both live commands declare the output-token ceiling, not only the one that spends the hold-out', () => {
  for (const command of ['scripts/eval-final-holdout.mjs', 'scripts/eval-live-model.mjs']) {
    const source = readFileSync(join(REPO_ROOT, command), 'utf8');
    assert.match(
      source,
      /maxOutputTokens: evals\.LIVE_MODEL_LANE_MAX_OUTPUT_TOKENS/,
      `${command} must bound output tokens as well as calls: the call cap does not bound spend, because the per-call token budget sits underneath it and has already moved once`,
    );
  }
});

/**
 * 🔴 The gate document's record table against the records directory, red in
 * BOTH directions.
 *
 * The table opened "Six attempts, every one recorded rather than tidied away"
 * over six rows while the directory held eight — a document asserting
 * completeness that was not complete, which `code-reviewer` took at the AIC-19
 * gate. The count is the kind of fact `.claude/rules/invariants.md` says must
 * have one source or a correspondence check between the copies; a table a reader
 * needs cannot be generated, so it gets the check.
 *
 * Both directions matter: a record added without a row makes the table
 * incomplete, and a row naming no record makes it fiction.
 */
test('the gate document names every hold-out record, and every record it names exists', () => {
  const dir = join(REPO_ROOT, 'docs/evidence/final-evaluation');
  const doc = readFileSync(join(REPO_ROOT, 'docs/v0.2-exit-gate.md'), 'utf8');

  const onDisk = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .sort();
  const table = doc.slice(doc.indexOf('| record | candidate | status |'));
  const named = [...table.matchAll(/^\| `([0-9a-f]{12})` \|/gm)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(
    named,
    onDisk,
    'the gate document\'s record table and docs/evidence/final-evaluation/ must name the same records: a record with no row makes the table\'s completeness claim false, and a row with no record makes it fiction',
  );

  const claimed = `${onDisk.length} attempts, every one recorded rather than tidied away`;
  assert.ok(
    doc.includes(claimed),
    `the sentence above the table must state the number of records there are — expected "${claimed}"`,
  );
});

/**
 * 🔴 The ceiling's margin, MEASURED against the committed evidence rather than
 * written into a comment.
 *
 * The first version of the constant's rationale named "the largest live run
 * recorded in `docs/evidence/`" and quoted a run that was not the largest, then
 * derived a margin from it that did not follow. Both gates took it, and they
 * disagreed with each other about the real figure — which is the argument for
 * computing it rather than stating it.
 *
 * This also fails LOUDLY if a future run approaches the ceiling, which is the
 * warning a comment cannot give: the cap throws mid-run, so a sweep that would
 * hit it should redden here first.
 */
test('leaves the output-token ceiling above every live run this repository has recorded', () => {
  const roots = ['docs/evidence/calibration', 'docs/evidence/final-evaluation'];
  let heaviest = { perCall: 0, file: '(none)' };

  for (const root of roots) {
    for (const name of readdirSync(join(REPO_ROOT, root)).filter((f) => f.endsWith('.json'))) {
      const parsed = JSON.parse(readFileSync(join(REPO_ROOT, root, name), 'utf8'));
      for (const carrier of [parsed, parsed.report ?? {}]) {
        const usage = carrier?.arms?.model?.usage;
        if (!usage || !usage.calls) continue;
        const perCall = usage.outputTokens / usage.calls;
        if (perCall > heaviest.perCall) heaviest = { perCall, file: `${root}/${name}` };
      }
    }
  }
  const heaviestPerCall = heaviest.perCall;

  assert.ok(
    heaviestPerCall > 0,
    'no committed record carries a model-arm usage block with a call count, so this row would pass vacuously',
  );
  // 🔴 Projected over a FULL-LENGTH run, not compared against a total.
  //
  // The cap throws MID-RUN, so the question it has to survive is not "is it
  // bigger than the largest run so far" — the largest recorded run is 47 calls
  // against a 150-call cap. It is "can a legitimate full-length run reach it".
  // The first version of this row compared totals and reported a 5.19x margin
  // where the full-run margin was 1.52x, which would have aborted a hold-out
  // costing barely more per call than one already recorded, spending the corpus
  // and producing nothing.
  const projected = Math.ceil(heaviestPerCall * LIVE_MODEL_LANE_MAX_MODEL_CALLS);
  assert.ok(
    LIVE_MODEL_LANE_MAX_OUTPUT_TOKENS > projected * 2,
    `the output-token ceiling (${LIVE_MODEL_LANE_MAX_OUTPUT_TOKENS}) must leave a full-length run room to finish: the heaviest per-call rate this repository has recorded is ${Math.round(heaviestPerCall)} output tokens (${heaviest.file}), which over the ${LIVE_MODEL_LANE_MAX_MODEL_CALLS}-call cap projects to ${projected}. A ceiling within reach of that aborts an honest run mid-flight instead of bounding a runaway one`,
  );
});

/**
 * The one baseline this repository ships must be usable from the command that
 * takes a baseline path.
 *
 * `--control-baseline` passed the parsed file straight through, so pointing it
 * at `docs/evidence/control-baseline.json` was refused by the lane for declaring
 * `_why`, `_measured`, `_limit` and `_completeness` — metrics it does not
 * compare. It failed closed, so nothing was published wrongly; it made the
 * shipped baseline unusable from the cheap lane. Found by `code-reviewer`.
 */
test("reads the repository's own committed baseline from the calibration command without refusing its rationale", async () => {
  const { readControlBaseline, CONTROL_BASELINE_PATH } = await import(
    '../scripts/eval-final-holdout.mjs'
  );
  const source = readFileSync(join(REPO_ROOT, 'scripts/eval-live-model.mjs'), 'utf8');
  const raw = JSON.parse(readFileSync(CONTROL_BASELINE_PATH, 'utf8'));

  assert.ok(
    Object.keys(raw).some((key) => key.startsWith('_')),
    'the committed baseline must carry rationale keys for this row to mean anything',
  );

  // Behaviour first: the shipped file, through the shared reader, must come out
  // as something the lane compares rather than as something it refuses.
  const declared = readControlBaseline(CONTROL_BASELINE_PATH);
  assert.equal(
    Object.keys(declared).some((key) => key.startsWith('_')),
    false,
    "the reader must strip `_`-prefixed rationale, or the repository's own baseline is refused by the lane as declaring metrics it does not compare",
  );

  // And ONE implementation of it. A second copy had already diverged from this
  // one — it lacked the empty-declaration refusal — which is the case
  // `.claude/rules/invariants.md` names: the copy nobody is looking at is the
  // one that is wrong.
  assert.match(
    source,
    /import \{ readControlBaseline \} from '\.\/eval-final-holdout\.mjs'/,
    'the calibration command must import the one baseline reader rather than carry its own',
  );
  assert.equal(
    /control-baseline\.json'?,\s*'utf8'/.test(source) ||
      /JSON\.parse\(readFileSync\(declaredBaselinePath/.test(source),
    false,
    'the calibration command must not parse the baseline itself: that second copy is what diverged',
  );
});
