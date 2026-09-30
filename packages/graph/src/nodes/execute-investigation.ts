import { createHash } from 'node:crypto';

import {
  buildExecKey,
  canonicalJson,
  InvestigationTestSchema,
  TrialSchema,
  type CommittedExecution,
  type Evidence,
  type EvidenceProvenance,
  type IncidentState,
  type InvestigationTest,
  type Trial,
  type TrialRefusal,
} from '@aic/domain';

import { ingestEvidence, nullPrototypeInput, readOwnProvenance, readOwnTrialRefusal } from '../evidence-ingestion.js';
import { deriveTrialId } from '../identity.js';
import type { InvestigationNode, InvestigationNodeResult } from '../investigation.js';
import type { ExecuteInvestigationContext } from '../index.js';

/**
 * The three outcomes one `execute` call can report — the same shape as
 * `ToolResult<Evidence[]>` in `packages/tools/src/contracts.ts`, restated here
 * rather than imported, because `@aic/graph` does not build against
 * `@aic/tools`: `packages/graph/package.json` declares no such dependency and
 * `packages/graph/tsconfig.json` references no tools project, so an import
 * fails the build. The two copies are held together by a compiled
 * correspondence check — see execute-investigation-outcome-type-contract.test.mjs
 * › "keeps the executor port's outcome type in step with the tool adapters'
 * ToolResult: every tool result is accepted and both name the same statuses".
 */
export type ExecuteInvestigationOutcome =
  | { status: 'ok'; output: readonly Evidence[]; provenance?: EvidenceProvenance }
  | { status: 'unavailable'; reason: string; refusal?: TrialRefusal }
  | { status: 'error'; message: string; refusal?: TrialRefusal };

/**
 * AIC-125 slice B: the canonical `execute_investigation` node.
 *
 * It runs only the tests still in state `planned`, in state order, and never
 * calls `execute` for a test in any other status — see
 * investigation-execution.test.mjs › "createExecuteInvestigation({execute})
 * calls execute for nothing and returns empty tests, trials and evidence when
 * no test is planned" and › "runs only the tests with status planned, in
 * state order, and never calls execute for executed, unavailable or failed
 * tests".
 *
 * Each executed test's trial identity comes from `deriveTrialId`
 * (`../identity.js`, exported by `@aic/graph`), with `attempt` one more
 * than the highest attempt already in state for that test's id, so a new
 * trial never lands on an existing trial id — see › "derives attempt as 1
 * plus the highest attempt already in state for that test's id", › "derives
 * attempt past the highest recorded attempt when a test's attempts are not
 * contiguous, so a new trial never lands on an existing trial id" and ›
 * "derives the trial id from the same identity formula
 * deriveTrialId uses: sha256 of JSON.stringify([runId, testId, attempt])" and
 * › "two planned tests sharing the same tool and input get distinct trial ids,
 * derived from their own test id".
 *
 * The three `ExecuteInvestigationOutcome` variants map onto a trial, a test
 * status and an evidence list exactly matching `projectToolResult`'s
 * `test.status` transitions in `packages/tools/src/contracts.ts` (`ok` ->
 * `executed`, `unavailable` -> `unavailable`, `error` -> `failed`) — but this
 * node never derives predictions or assessments, unlike that function's
 * `unavailable` arm: this slice's executor is deliberately silent on both
 * keys — see › "on an ok result: records an ok trial, emits new evidence
 * re-stamped with the trial id, marks the test executed, and touches neither
 * predictions nor assessments", › "on an ok result naming no evidence:
 * records an ok trial with empty evidenceIds and emits no evidence", › "on an
 * unavailable result: records an unavailable trial with no evidenceIds, emits
 * no evidence, and marks the test unavailable" and › "on an error result:
 * records an error trial with no evidenceIds, emits no evidence, and marks
 * the test failed". `durationMs` is always 0: a replay measures nothing, and
 * this node has no clock of its own to measure a live call with either.
 *
 * Every newly emitted evidence item is re-stamped with the trial id that
 * produced it, and an evidence id already held in state — or already claimed
 * earlier in this same call, by an earlier test's trial — is never re-emitted
 * and never credited to a second trial: that is what keeps
 * `trialEvidenceViolations` (`@aic/domain`) finding nothing on the result —
 * see › "on an ok result: an evidence item already held in state is not
 * re-emitted and keeps its original trialId", › "two planned tests with the
 * same tool and input: when execute returns evidence sharing a
 * content-derived id for both, only the first test's trial claims it and the
 * second's evidenceIds is empty" and › "applying the first call's result to
 * state by id (upsert) and calling again is idempotent: the second call
 * executes nothing, and trialEvidenceViolations over the resulting state
 * finds no violations".
 *
 * A thrown `execute` error propagates rather than being swallowed — see ›
 * "propagates a thrown error from execute instead of swallowing it".
 *
 * AIC-146 b4: an `unavailable` or `error` outcome may also carry a typed
 * `refusal` (`@aic/domain`'s `TrialRefusal`), read as an own data property
 * only and parsed with `TrialRefusalSchema` before it is ever stamped on the
 * Trial — see `../evidence-ingestion.js`'s own `readOwnTrialRefusal` for the
 * shared own-property discipline, and investigation-execution.test.mjs ›
 * "on an unavailable result: a well-formed refusal naming a binding UUID is
 * recorded on the trial (AIC-146 b4)", › "on an unavailable result carrying
 * no refusal: the recorded trial carries no refusal key at all (AIC-146 b4)"
 * and › "on an error result: a well-formed refusal naming a binding UUID is
 * recorded on the trial (AIC-146 b4)".
 *
 * Lane wiring — which graph edge calls this node — is a later slice's
 * concern, not this one's, matching `createDerivePredictions` and
 * `createEvaluatePredictions` (`./derive-predictions.js`,
 * `./evaluate-predictions.js`).
 */
/**
 * Parses one Trial via `TrialSchema`, building the parse input with
 * `nullPrototypeInput` (`../evidence-ingestion.js`) so a polluted
 * `Object.prototype.refusal` can never surface as an own `refusal` on the
 * recorded Trial — the same null-prototype discipline `ingestEvidence` uses
 * for `EvidenceProvenance` (AIC-146 b2), reused here for `refusal` (AIC-146
 * b4, security round 1) rather than re-implemented (`.claude/rules/invariants.md`,
 * "one mechanism, one implementation"). A post-parse assertion then checks
 * that the parsed Trial's own `refusal` presence matches whether a refusal
 * was actually supplied for this call — content-free, so it never echoes the
 * refusal's value. It is pinned directly — see investigation-execution.test.mjs
 * › "parseTrial throws, content-free, when the parsed trial's own refusal
 * does not match the refusal supplied for the call" — because inside the
 * node the null-prototype input already rules out a mismatch; it guards a
 * caller that passes fields and refusal that disagree. Every
 * `TrialSchema.parse` call in this file goes through here — see
 * evidence-ingestion-sites.test.mjs › "across every package and app source
 * tree, TrialSchema.parse and TrialSchema.safeParse appear only in the node
 * that builds trials and in the read-back of stored trials". The null-prototype
 * input is pinned by investigation-execution.test.mjs › "on an ok result carrying no own
 * refusal: a polluted Object.prototype.refusal never becomes an own property
 * of the recorded trial, even on a real ok trial (AIC-146 b4 security round
 * 1)", › "on an unavailable result carrying no own refusal: a polluted
 * Object.prototype.refusal never becomes an own property of the recorded
 * trial (AIC-146 b4 security round 1)" and › "on an error result carrying no
 * own refusal: a polluted Object.prototype.refusal never becomes an own
 * property of the recorded trial (AIC-146 b4 security round 1)".
 *
 * Exported so `../index.js`'s `recordsOf` (the durable runner's own
 * `TrialSchema.parse` site) reuses this exact function rather than growing a
 * second copy of the same null-prototype-input-and-post-parse-assert
 * discipline for a caller that always passes `refusal: undefined` — see
 * durable-tool-replay.test.mjs › "a polluted Object.prototype.refusal never
 * becomes an own property of the trial the durable runner records or the
 * trial it persists through project" (AIC-146 b4).
 */
export function parseTrial(fields: Readonly<Record<string, unknown>>, refusal: TrialRefusal | undefined): Trial {
  const trial = TrialSchema.parse(nullPrototypeInput(fields));
  if (Object.hasOwn(trial, 'refusal') !== (refusal !== undefined)) {
    throw new Error('parsed trial refusal presence does not match what was supplied for this call');
  }
  return trial;
}

/**
 * AIC-146 b5: `evidenceProvenance` — `'optional'` (the default, and the
 * behaviour when the option is omitted entirely) or `'required'`.
 *
 * The default stays `'optional'` because two arms this node already serves
 * carry no provenance at all: a replay of a recorded run, and a scripted
 * evaluation lane — neither has a live adapter to stamp one, and requiring it
 * there would make every existing replay and scripted-lane test throw. A
 * caller on the bound-source path (a real tool adapter) opts into
 * `'required'` instead, so an adapter's own missing stamp is refused at this
 * node rather than silently landing as evidence carrying no `provenance`
 * field — see investigation-execution.test.mjs › "createExecuteInvestigation({execute,
 * evidenceProvenance: \"required\"}): an ok outcome whose output is non-empty
 * but carries no own provenance throws a content-free message naming
 * provenance, and records nothing (AIC-146 b5)".
 *
 * Any value other than `'optional'` or `'required'` is refused synchronously
 * at construction, before `execute` is ever called — see › "createExecuteInvestigation
 * refuses an unknown evidenceProvenance option value at construction, before
 * execute is ever called (AIC-146 b5)".
 *
 * `'required'` constrains only `ok` outcomes whose `output` is non-empty:
 * an `ok` outcome with empty output has nothing to stamp, and an
 * `unavailable` or `error` outcome carries no evidence at all — both are
 * exempt — see › "an ok outcome with EMPTY output and no provenance does not
 * throw — there is nothing to stamp (AIC-146 b5)", › "an unavailable outcome
 * with no provenance does not throw — the required option constrains only ok
 * outcomes (AIC-146 b5)" and › "an error outcome with no provenance does not
 * throw — the required option constrains only ok outcomes (AIC-146 b5)".
 * The check reuses `readOwnProvenance` (`../evidence-ingestion.js`) — the
 * same own-data-property reader `ingestEvidence` already uses to read
 * `outcome.provenance` — rather than a second, parallel check
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation"), and
 * runs before anything from the failing test's outcome is recorded: across
 * two planned tests, a later outcome missing provenance rejects the whole
 * call, discarding the earlier, well-stamped test's result too — see ›
 * "across two planned tests, a later ok outcome missing provenance rejects
 * the whole call — nothing from the earlier, well-stamped test is returned
 * either (AIC-146 b5)".
 */
export type EvidenceProvenanceRequirement = 'optional' | 'required';

function assertKnownEvidenceProvenance(value: EvidenceProvenanceRequirement): void {
  if (value !== 'optional' && value !== 'required') {
    throw new Error('evidenceProvenance must be "optional" or "required"');
  }
}

/**
 * One planned test's trial identity, computed before `execute` ever runs so
 * the same identity is available to build the exec key AND to build the
 * eventual Trial.
 */
type TrialBase = Readonly<{
  id: string;
  runId: string;
  testId: string;
  attempt: number;
  tool: InvestigationTest['tool'];
  input: unknown;
  durationMs: 0;
}>;

/**
 * Turns one `ExecuteInvestigationOutcome` into the test/trial/evidence this
 * node records for it, extracted so it can run twice for the same outcome (AIC-146 c1): once
 * inside `execution.committed`'s `compute`, purely to let its own throws
 * (required-provenance, an item smuggling its own provenance, a malformed
 * refusal) refuse the outcome BEFORE it is committed, and once for real,
 * after `compute`'s result — freshly computed or replayed — comes back, to
 * build what this call actually returns. This mirrors the durable runner's
 * own `recordsOf` (`../index.ts`), called the same way for the same reason.
 *
 * `claimedEvidenceIds` is mutated by the real call (an id claimed by an
 * earlier test in this same node call is never re-claimed by a later one);
 * the validation-only call inside `compute` is given a throwaway copy so a
 * refusal can never poison the real dedup state before a commit succeeds.
 */
function buildRecordedOutcome(
  test: InvestigationTest,
  trialBase: TrialBase,
  outcome: ExecuteInvestigationOutcome,
  { evidenceProvenance, claimedEvidenceIds }: Readonly<{ evidenceProvenance: EvidenceProvenanceRequirement; claimedEvidenceIds: Set<string> }>,
): { test: InvestigationTest; trial: Trial; evidenceItems: Evidence[] } {
  if (outcome.status === 'ok') {
    if (evidenceProvenance === 'required' && outcome.output.length > 0 && readOwnProvenance(outcome) === undefined) {
      throw new Error('evidence provenance is required but this ok outcome carries none');
    }
    const evidenceIds: string[] = [];
    const evidenceItems: Evidence[] = [];
    for (const item of outcome.output) {
      if (claimedEvidenceIds.has(item.id)) continue;
      claimedEvidenceIds.add(item.id);
      evidenceIds.push(item.id);
      // Provenance travels alongside the outcome, never inside an item: an
      // item carrying its own `provenance` is refused outright by
      // `ingestEvidence`, and a well-formed `outcome.provenance` is stamped
      // onto every newly recorded item exactly as given — see
      // investigation-execution.test.mjs › "on an ok result: an evidence item
      // carrying its own provenance is refused, naming the evidence id, and
      // nothing is recorded (AIC-146 b2)" and › "on an ok result: a
      // well-formed provenance block on the outcome is stamped onto every
      // newly recorded evidence item, exactly as given (AIC-146 b2)".
      evidenceItems.push(ingestEvidence({ item, trialId: trialBase.id, provenanceSource: outcome }));
    }
    return {
      test: InvestigationTestSchema.parse({ ...test, status: 'executed' }),
      trial: parseTrial({ ...trialBase, status: 'ok', evidenceIds }, undefined),
      evidenceItems,
    };
  }

  if (outcome.status === 'unavailable') {
    // The refusal reason is read as an own data property only, and parsed
    // with TrialRefusalSchema, before it is ever stamped on the Trial — see
    // evidence-ingestion.ts's `readOwnTrialRefusal` (AIC-146 b4), which
    // shares the exact own-property discipline `readOwnProvenance` already
    // uses for the ok branch above.
    const refusal = readOwnTrialRefusal(outcome);
    return {
      test: InvestigationTestSchema.parse({ ...test, status: 'unavailable' }),
      trial: parseTrial(
        { ...trialBase, status: 'unavailable', evidenceIds: [], ...(refusal === undefined ? {} : { refusal }) },
        refusal,
      ),
      evidenceItems: [],
    };
  }

  const refusal = readOwnTrialRefusal(outcome);
  return {
    test: InvestigationTestSchema.parse({ ...test, status: 'failed' }),
    trial: parseTrial(
      { ...trialBase, status: 'error', evidenceIds: [], ...(refusal === undefined ? {} : { refusal }) },
      refusal,
    ),
    evidenceItems: [],
  };
}

/**
 * `sha256:` plus the hex sha256 of `JSON.stringify(canonicalJson({ tool,
 * input }))` — pinned by investigation-execution-committed.test.mjs ›
 * "inputFingerprint sent to execution.committed equals sha256: plus the sha256
 * of a hand-sorted {tool, input} envelope".
 */
function computeInputFingerprint(tool: unknown, input: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalJson({ tool, input }))).digest('hex')}`;
}

export function createExecuteInvestigation({
  execute,
  evidenceProvenance = 'optional',
  execution,
}: Readonly<{
  execute(context: ExecuteInvestigationContext): Promise<ExecuteInvestigationOutcome>;
  evidenceProvenance?: EvidenceProvenanceRequirement;
  execution?: CommittedExecution;
}>): InvestigationNode {
  assertKnownEvidenceProvenance(evidenceProvenance);

  return async (state: IncidentState): Promise<InvestigationNodeResult> => {
    const plannedTests = state.tests.filter((test) => test.status === 'planned');
    if (plannedTests.length === 0) {
      return { tests: [], trials: [], evidence: [] };
    }

    const highestAttemptByTestId = new Map<string, number>();
    for (const trial of state.trials) {
      highestAttemptByTestId.set(
        trial.testId,
        Math.max(highestAttemptByTestId.get(trial.testId) ?? 0, trial.attempt),
      );
    }

    // Evidence already held in state, plus every id claimed earlier in this
    // same call — both must be excluded from re-emission and from a second
    // trial's evidenceIds, or a replayed/duplicated tool answer would be
    // credited to two trials at once.
    const claimedEvidenceIds = new Set(state.evidence.map((item) => item.id));

    const tests: InvestigationTest[] = [];
    const trials: Trial[] = [];
    const evidence: Evidence[] = [];

    for (const test of plannedTests) {
      const attempt = (highestAttemptByTestId.get(test.id) ?? 0) + 1;
      const trialId = deriveTrialId({ runId: state.control.runId, testId: test.id, attempt });
      const trialBase: TrialBase = {
        id: trialId,
        runId: state.control.runId,
        testId: test.id,
        attempt,
        tool: test.tool,
        input: test.input,
        // A replay measures nothing, and this node has no clock of its own
        // to measure a live call with either.
        durationMs: 0,
      };

      // AIC-146 c1: with `execution`, this one test's outcome is committed
      // under its own `tool.trial` exec key, so a replay of the same
      // pre-checkpoint state reuses it instead of calling `execute` again.
      // `compute` runs `execute` AND `buildRecordedOutcome`'s validation
      // (required provenance, an item smuggling its own provenance, a
      // malformed refusal) BEFORE returning, on a throwaway copy of
      // `claimedEvidenceIds` — so a refused outcome throws inside `compute`
      // and is never committed, matching the durable runner's own `call` /
      // `recordsOf` pairing (`../index.ts`). Without `execution` the outcome
      // is validated once, by the record build below, as before.
      const call = () =>
        execute({
          runId: state.control.runId,
          testId: test.id,
          attempt,
          tool: test.tool,
          input: test.input,
        });
      const compute = async (): Promise<ExecuteInvestigationOutcome> => {
        const computed = await call();
        buildRecordedOutcome(test, trialBase, computed, {
          evidenceProvenance,
          claimedEvidenceIds: new Set(claimedEvidenceIds),
        });
        return computed;
      };

      const outcome = execution
        ? await execution.committed(
            buildExecKey('tool.trial', { runId: state.control.runId, testId: test.id, trialAttempt: attempt }),
            compute,
            {
              inputFingerprint: computeInputFingerprint(test.tool, test.input),
              // AIC-146 c1b: the records written with the commit are the ones
              // this node records for the test below, built by the same
              // function on a copy of `claimedEvidenceIds` — see
              // investigation-execution-committed.test.mjs › "project writes
              // exactly the trial and evidence the node records for that test".
              project: (committed) => {
                const { trial, evidenceItems } = buildRecordedOutcome(test, trialBase, committed, {
                  evidenceProvenance,
                  claimedEvidenceIds: new Set(claimedEvidenceIds),
                });
                return { trials: [trial], evidence: evidenceItems };
              },
            },
          )
        : await call();

      const recorded = buildRecordedOutcome(test, trialBase, outcome, { evidenceProvenance, claimedEvidenceIds });
      tests.push(recorded.test);
      trials.push(recorded.trial);
      evidence.push(...recorded.evidenceItems);
    }

    return { tests, trials, evidence };
  };
}
