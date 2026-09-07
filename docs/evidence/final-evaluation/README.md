# The final hold-out evaluation, and what its records mean

AIC-19 requires a **declared one-shot final hold-out evaluation**. This
directory is where the one shot is recorded. One file per candidate, committed,
named after the first twelve characters of the candidate fingerprint.

Run it with `npm run eval:final-holdout`. Run `npm run eval:final-holdout
--dry-run` to see every guard's verdict without executing anything — that is
also how a reviewer checks a record without spending a corpus.

## Why the key is a candidate fingerprint and not the commit SHA

The obvious design refuses a second run at the same commit. It does not hold,
and the failure is worth stating because a future reader will otherwise
reintroduce it.

The run happens at SHA X. The record must be committed — a gitignored record is
one `rm` away from a free and invisible re-run. Committing it produces SHA Y. A
re-run at Y is then a re-run at a "new commit" whose only difference is the
evidence the previous run wrote. **The lock opens itself, once per re-run,
forever.**

So the key is a hash over the git object ids of the paths that can change what
the graph does — `FINAL_EVALUATION_CANDIDATE_PATHS` in
`packages/evals/src/final-evaluation-record.ts`, which this file deliberately
does not restate. Committing evidence does not move it; editing `packages/`
does. The commit SHA still travels *in* the record, because AIC-19 asks for the
exact candidate SHA, but as attribution rather than as identity.

The exclusion list is asymmetric on purpose: **omitting a path that does affect
behaviour causes a false refusal, which is safe; including a path that does not
causes a false unlock, which is not.**

## When a re-run is legitimate

Two cases, both records, neither a flag.

1. **The code changed.** The fingerprint moves, no record covers the new
   candidate, the run is admitted and a second record lands beside the first. A
   reader then sees both the evaluation that failed and the one after the fix,
   which is more informative than a corpus that was only ever run once.
2. **The run produced no information** — a crash, an ingestion refusal before
   any scenario executed, an operator interrupt. The remedy is a committed
   record with `"status": "void"`, a `voidReason` and a `voidedBy` naming a
   person. Written by hand, reviewed as a diff, and admitted by
   `decideFinalEvaluation` as covering nothing.

There is deliberately no `--force`. A flag is invoked; a committed void is
argued for in review, and if voiding becomes routine the diffs say so.

A record whose `status` is `claimed` and never became `complete` **still
refuses**, because the corpus is spent when scenarios execute rather than when
the report is written. If a claim is stranded, the runs happened.

## What this does not protect against

Written down because a mechanism whose limits are not stated is one a reader
assumes covers more than it does.

1. **It does not stop a re-run; it makes one visible and deliberate.** Anyone
   can change a whitespace character under `packages/`, move the fingerprint and
   earn a fresh admission. What they cannot do is earn it without a commit a
   reviewer can see. Iterative tuning against the hold-out stays *possible* and
   becomes *legible*.
2. **A deleted or rewritten record is caught by nothing here.** The record's
   integrity rests on git history and code review. There is no signature and no
   external witness, because adding one means infrastructure.
3. **The refusal is in the command, not in the library.** An in-process caller
   that imports `runGraphBenchmarkExperiment` and passes
   `scenarioSet: 'final-evaluation'` is not refused. The audit row
   `final-evaluation-command.test.mjs › "reaches the final-evaluation corpus from
   exactly one command in this repository"` catches a *committed* second caller;
   it does not catch a scratch script or a `node -e`.
4. **It says nothing about whether the numbers are right.** The record proves
   *when* and *against what* the hold-out ran, not that the evaluation measured
   anything worth measuring.
5. **The candidate fingerprint is a proxy.** It covers tracked files at declared
   paths. Behaviour that varies with an environment variable, a provider-side
   model change, a clock or a network condition is outside it entirely — two
   runs at one fingerprint are not guaranteed to be two runs of the same system.
6. **It cannot tell a first look from a second.** The hold-out fixtures are
   public source in `packages/evals/src/replay-scenarios.ts`. Someone who reads
   them, tunes against them and *then* runs the evaluation once leaves a clean
   one-shot record. The corpus is protected from automated re-evaluation, not
   from reading.
7. **A deterministic-only final evaluation would be worse than none.** The
   replay-backed control arm scores a single value of zero on every metric it
   emits over this corpus, so spending the one shot on it would produce a record
   carrying no information about the candidate. The command runs both arms and
   requires the model arm; that is why it needs a provider credential and
   refuses without one.
