/**
 * The queue's own state — today, exactly one field: the tier of the last item
 * the loop closed.
 *
 * 🔴 **Why this file exists at all.** `selectNext` rations the elevated tier by
 * spacing: never two elevated items back to back — where the FIRST one is the
 * half of the tier that executes (`tierOf` below), and the second is still any
 * item whose marker says `elevated`. The asymmetry is not an oversight: a
 * candidate has no diff yet, so there is nothing to classify it from, while a
 * close does. It reads
 * `config.lastCompletedTier` — and nothing anywhere wrote it, so the filter was
 * called with `null` on every selection and **the ration never fired between
 * tasks**. The rule was upheld by whichever session happened to read it, which
 * is precisely the guarantee a mechanical filter exists to replace. A filter
 * whose input nobody supplies is indistinguishable from a filter that agrees
 * with you, and neither a green suite nor a reading of `core.mjs` shows it.
 *
 * 🔴 **The tier is computed from the change, never taken from the item's
 * marker.** `autonomy.md`: *"the tier is decided by what the change touches, not
 * by what the task said it would touch"*, and the `loop` skill calls the marker
 * *"a pre-filter, not the authority"*. Rationing on the marker would mean a
 * marker written one tier low silently buys a second elevated item in a row —
 * which is the failure this repo has already recorded, on the very item that
 * produced this module. The marker stays useful as a hint and a hygiene signal;
 * it is not the value anything rations on.
 *
 * That costs no judgement: the gate sweep already decides this question
 * mechanically, and this module calls the sweep's own functions rather than
 * re-deriving the rules. **One mechanism, one implementation**
 * (`invariants.md`) — two files deciding "is this path elevated" would disagree,
 * and the one nobody is looking at would be the wrong one.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { elevatedPathsIn, executesNothing, readDeclaredPaths } from '../detect-missed-gate.mjs';
import { updateState } from '../run-state.mjs';
import { mainCheckoutRoot } from './checkout.mjs';


/**
 * A ticket id, as the three adapters in this rulebook actually emit them.
 *
 * 🔴 It is validated because the value builds a PATH. `../../etc` would name a
 * file outside the claims directory entirely, and an exclusion that can be
 * pointed anywhere is not an exclusion — it is a way to opt any single file out
 * of the ration. The class below admits a letter or digit followed by letters,
 * digits, `_` and `-`, which covers `jira` (`AIC-70`), `github-issues`
 * (`String(issue.number)` → `42`) and `plan-md` (`String(n)` → `3`), and admits
 * no `.`, `/` or `\` — so no value that passes can escape `.rig/claims/`.
 *
 * ⚠ **An id that is well-formed but not this task's is applied, not refused.**
 * Passing another item's id excludes THAT record instead, exactly as passing a
 * truncated `changedFiles` records the wrong tier: the caller owns which item it
 * is closing, and nothing here can check that claim. Stated because the reader
 * of the check above will otherwise read it as validating more than shape.
 */
const TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * The one elevated path a task crosses because the PROCEDURE says so, not
 * because of what the work touched.
 *
 * Every task writes `.rig/claims/<ticket>.json` — the `loop` skill requires the
 * record, and `AGENTS.md` declares the whole of `.rig/` elevated. So before
 * AIC-70 every close recorded `elevated-mechanism`, and a ration that fires on
 * every item spaces nothing: it is indistinguishable from a ration that is off
 * (`see test/queue-tier-spacing.test.mjs › "spaces the next item when no ticket
 * is given, rather than guessing"`, which pins that pre-exclusion answer for
 * exactly this shape of diff).
 *
 * ⚠ **Only the CURRENT task's record, and only for the ration.** Another task's
 * claim record decides someone else's revalidation and nothing in this task's
 * procedure requires touching it. And `elevatedPaths` in the return value keeps
 * naming this file either way — that answers the GATE's question, and a close
 * that stopped listing it would look clean to the sweep built to catch merges
 * across elevated paths.
 *
 * Returns `null` for an id it does not recognise. 🔴 It does NOT throw, and that
 * is the whole lesson of this function's first version: it validated inside the
 * `filter` callback, so a bad id was silent when nothing was elevated and threw
 * when something was — and the throw landed BEFORE the state file was written,
 * leaving the ration reading `null`, which `clearsSpacing` treats as "go ahead".
 * The guard failed open on precisely the closes it exists to ration. A refusal
 * that discards the tier is more permissive than no refusal at all.
 */
const canonicalClaimRecord = (ticket) =>
  typeof ticket === 'string' && TICKET_ID.test(ticket) ? `.rig/claims/${ticket}.json` : null;

/**
 * The tier of a close, from the elevated paths the change crossed.
 *
 * 🔴 **The elevated tier splits in two, and only the ration reads the split.**
 * `elevated-prose` is still an elevated change everywhere it is REVIEWED — the
 * model lane, the cold readers, the `human-review` label, the gate sweep. It
 * simply does not space the next item, because the rule's own stated purpose is
 * about what compounds: *"one **unreviewed** schema or permissions change is
 * recoverable; a chain of them compounding overnight is not"*. A rule file
 * cannot compound into a broken runtime overnight, because nothing executes it —
 * and in a repository whose rulebook lives under a declared path, spacing on the
 * undivided word halts the queue rather than pacing it.
 *
 * A mixed diff is `elevated-mechanism`: the half that runs decides. Reading the
 * tier off the first path, or off "most of them are documents", would ship a
 * ration any diff can opt out of by also touching a `.md`.
 *
 * The predicate is `executesNothing` — **`.md` only, not `.mdx`** — imported
 * from `detect-missed-gate.mjs` so it sits beside the sweep's own markdown test
 * rather than drifting from it. The two are deliberately different and the
 * difference is the ration's whole subject: the sweep asks *does this need a
 * reviewer*, this asks *can it compound overnight*, and MDX is a program that
 * renders (`docs/decisions/review-lanes.md`).
 *
 * ⚠ **The limit worth knowing before trusting this:** a skill's `SKILL.md` is
 * prose by this test, and some of them carry shell snippets an agent copies and
 * runs. The owner's ruling is that skills stay prose for rationing — they are
 * reviewed like the rules they are, and rewriting a procedure is not the chain
 * of unreviewed compounding changes the ration was bought to stop. It is,
 * however, the weakest ground the "no runtime executes it" justification stands
 * on, and the place to look first if the ration ever turns out too loose.
 *
 * ⚠ Two more limits, both erring toward holding: the test is case-sensitive, so
 * `RULES.MD` records `elevated-mechanism`; and only paths `elevatedPathsIn`
 * already returned reach here, so a non-rulebook `.md` was dropped as inert long
 * before and records `normal` — which clears the ration outright rather than as
 * prose (`docs/decisions/review-lanes.md`).
 */
const tierOf = (elevated, excluded) => {
  // No exclusion to apply — no ticket, or one this module does not recognise.
  // Deriving one from the diff would let any change opt out of the ration by
  // adding a file shaped like a claim record.
  //
  // 🔴 The comparison is `!==`, never a substring test. `.rig/claims/AIC-70.json.bak`
  // and `.rig/claims/sub/AIC-70.json` are different files and stay elevated;
  // a containment check would drop both, which is how "exclude only the
  // canonical record" quietly becomes "exclude anything named like it".
  const rationed = excluded === null ? elevated : elevated.filter((path) => path !== excluded);
  if (rationed.length === 0) return 'normal';
  return rationed.every(executesNothing) ? 'elevated-prose' : 'elevated-mechanism';
};

/**
 * Record the tier of the change that just closed an item.
 *
 * `changedFiles` is the diff's file list — `git diff --name-only <base>...<head>`
 * for the merged PR. It is a required argument and not a defaulted one, which is
 * the whole point of the two refusals below.
 *
 * `ticket` is the item being closed. It is what excludes that task's own
 * `.rig/claims/<ticket>.json` from the SPACING decision — see
 * `canonicalClaimRecord` for why the procedure's own file must not ration the
 * next item. Omitting it is safe and conservative: the record then counts, which
 * is the pre-AIC-70 behaviour.
 *
 * Returns `{ tier, elevatedPaths }`: the value written, and the files that
 * earned it, so the close step can journal *why* rather than just *what*.
 * `elevatedPaths` is always an array — never absent, and **unaffected by both
 * the prose/mechanism split above and the claim-record exclusion**. ⚠ Since
 * AIC-70 a `normal` tier and a NON-EMPTY `elevatedPaths` co-exist, and that
 * pairing is the point: the ration ignored the task's own claim record, the gate
 * must still see it (`see test/queue-tier-spacing.test.mjs › "still names the
 * claim record in elevatedPaths, because the gate asks a different question"`).
 * A consumer written against "normal means nothing was crossed" would stop
 * journalling the record on exactly the closes the sweep exists to catch. `elevatedPaths` answers
 * "what did this change cross", which is the gate's question and not the
 * ration's: a prose merge that stopped listing its rulebook files would look
 * clean to the sweep that exists to catch exactly those merges.
 *
 * 🔴 **It writes a state file BESIDE the queue config, never into it — and that
 * is not a preference.** `.claude/queue.json` is composed from the rig's
 * template layer, so a runtime value written into it is drift: the repository's
 * own sync check fails, and in a generated project the next `upgrade` has a
 * conflict on a file the project never edited. The item that asked for this
 * named the config as the target ("the file `selectNext` already reads"); it was
 * right about the reader and wrong about the file, and the drift check is what
 * proved it. Config is composed and tracked; state is per-checkout and ignored.
 *
 * ⚠ **The limit this cannot see, stated rather than covered by a test that
 * would only look like coverage:** a file list that arrived **truncated** — a
 * split on the wrong separator, a hand-trimmed array, a caller that filtered
 * before passing — is indistinguishable here from a complete one, and a
 * truncated list that drops the elevated file records `normal`. The empty-list
 * refusal below does not catch it, because a short list is not an empty one.
 * The caller owns completeness. (A `maxBuffer` overflow is NOT one of these
 * cases: `execFileSync`, which the documented snippet uses, throws `ENOBUFS`
 * rather than returning a short string — measured, so it fails loudly.)
 */
export const recordCompletedTier = ({
  changedFiles,
  projectRoot,
  statePath,
  runDir,
  ticket,
} = {}) => {
  // 🔴 An absent file list is NOT a normal change. A zero and an unknown look
  // identical in a count and mean opposite things, and guessing `normal` here
  // would rebuild the exact blind spot this module closes: the permissive
  // answer, written confidently, with nothing to show it was never measured.
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    throw new Error(
      'recordCompletedTier needs the changed file list of the closing change ' +
        '(`git diff --name-only <base>...<head>`). An empty or missing list is an ' +
        'absence, not a normal-tier change, and writing a tier from it would ration ' +
        'the queue on a value nobody measured.',
    );
  }

  // Same refusal, one layer up: a project that declares no elevated path at all
  // would make every change look `normal` forever. `readDeclaredPaths` returns
  // null rather than [] for exactly this case, and the sweep treats it as its
  // own finding rather than as "no findings".
  const declared = readDeclaredPaths(projectRoot);
  if (!declared || declared.length === 0) {
    throw new Error(
      'nothing in this project declares an elevated path, so no tier can be ' +
        'computed: add an `elevated-paths` block to AGENTS.md or a rule file. ' +
        'Treating the absence as `normal` would ration on a declaration that ' +
        'does not exist.',
    );
  }

  const elevated = elevatedPathsIn(changedFiles, declared);
  // Resolved ONCE, before any classification, so an unrecognised id cannot make
  // this depend on whether the diff happened to cross an elevated path.
  const excluded = ticket === undefined || ticket === null ? null : canonicalClaimRecord(ticket);
  const tier = tierOf(elevated, excluded);

  // State only. It deliberately does NOT carry `adapter` or `options`: two files
  // answering "which queue is this" is two answers with no rule for which wins,
  // and the loser is whichever one nobody is looking at.
  //
  // The default lands in the MAIN checkout even when the close runs inside a
  // worktree — see `mainCheckoutRoot`. An explicit `statePath` is used verbatim
  // and never re-resolved: it is the escape hatch tests and odd layouts need,
  // and silently relocating it would make it useless.
  //
  // Note the asymmetry, which is deliberate: the DECLARATION is read from the
  // given `projectRoot` (the worktree's own `AGENTS.md` is the rulebook the
  // change was written against), while the STATE goes to the checkout that
  // outlives the task.
  const file = statePath ?? join(mainCheckoutRoot(projectRoot), '.claude', 'queue.state.json');
  writeFileSync(file, `${JSON.stringify({ lastCompletedTier: tier }, null, 2)}\n`);

  // The run's own state, when the run declared a directory. Two files because
  // the two values have different lifetimes: the tier rations ACROSS runs and
  // belongs to the checkout, while the escalation streak means "twice in a row
  // in THIS run" — see `run-state.mjs`. Writing either into the other's file
  // silently breaks the rule it exists for.
  //
  // 🔴 A close BREAKS the streak, and that is the point of writing it here.
  // "Two escalations in a row" ends when something lands in between; a counter
  // nothing resets turns the second escalation of a long, otherwise healthy run
  // into a permanent stop.
  //
  // `updateState` merges, so the budget and the trigger record this run has
  // accumulated survive — unlike the whole-file write above, which owns its
  // file outright.
  //
  // The tier goes into both files, and only one of them is read back: selection
  // takes it from the per-checkout file above. The run-state copy is a trace of
  // what this run closed — the item's own state shape names it — not a second
  // input to the ration, and reading it as one would be the per-run clean slate
  // this module exists to prevent.
  //
  // ⚠ **Deliberately untried, unlike the same call inside `recordEscalation`.**
  // There the caller has already mutated a tracker, so a throw would report a
  // successful escalation as a failure and invite a double-posted comment. Here
  // the durable half — the tier the ration reads — is already on disk one line
  // above, and the half that can still fail is the streak reset, whose loss
  // stops the run EARLIER than it needed to. A failure that errs toward
  // stopping is one to hear about, not one to swallow.
  if (runDir) updateState(runDir, { lastCompletedTier: tier, escalations: 0 });

  // `ticketIgnored` names an id that was supplied and not recognised. The tier is
  // still recorded — conservatively, with no exclusion applied — because the one
  // thing this function must never do is leave the ration unwritten.
  const ignored = ticket !== undefined && ticket !== null && excluded === null;
  return { tier, elevatedPaths: elevated, ...(ignored ? { ticketIgnored: ticket } : {}) };
};
