# Why the close command looks the way it does

The rule lives in the `loop` skill, section 9 ("State updates bracket the task").
This file is the evidence behind each argument in the `recordCompletedTier`
call, and it is not loaded into any session. Read it before "simplifying" that
command.

Four of the six were live defects; `execFileSync` with an argument array is
prophylaxis, and `ticket` arrived with AIC-70. They do **not** fail the same
way, and the difference is the whole reason each is pinned rather than left to
judgement:

| argument | how it fails when wrong |
| --- | --- |
| `-z` | silently, **permissively** — records `normal` for an elevated change |
| `ticket` | silently, **permissively**, for an id that is well-formed but not this item's — it excludes that item's claim record instead. An id the module cannot recognise is named back in `ticketIgnored` and excludes nothing |
| `runDir` | silently, but toward a **stop** nobody can clear |
| the diff form | **loudly** — the call refuses on an empty file list |
| `env: withoutGitLocation()` | loudly, for the sha-to-sha form pinned here; it is prophylaxis for this call and load-bearing for every symbolic-ref spawn |
| `execFileSync` array | it does not; nothing is interpolated into a shell today |

**Two of the six fail silently in the permissive direction**, and the second one
is newer than the sentence that used to say there was exactly one. `ticket`
earned its row the hard way: its first implementation validated the id inside
the `filter` callback, so a bad id was silent when nothing was elevated and
**threw** when something was — and the throw landed before the state file was
written, leaving the ration reading nothing at all. `clearsSpacing` treats that
as "go ahead", so the guard failed open on precisely the elevated closes it
exists to ration. It now resolves the id once, before classifying, and an
unrecognised id records the tier it would have recorded before AIC-70 rather
than discarding it (`see test/queue-tier-spacing.test.mjs › "records a
conservative tier for an id it cannot recognise, and never leaves the ration
unwritten"`).

## `runDir`

It is what resets the escalation streak: the close is the "something landed in
between" that makes the run-level stop "two escalations **in a row**" mean two
in a row. Omit it and the counter only ever rises — two escalations an hour
apart end the run however many tasks closed between them.

The parameter is optional in the signature. So leaving it out does not throw; it
fails quietly, and in the direction of a stop nobody can clear.

## `<merge-sha>^1 <merge-sha>`, never `origin/<default>...<merge-sha>`

A three-dot diff is `merge-base..head`. Once the remote-tracking ref includes the
merge — which is exactly its state at the moment this step runs — the merge base
_is_ the merge, so the file list comes back **empty** and the call refuses.

The three-dot form appeared to work for a while. It only ever worked while the
local ref happened to be stale: an accident of ordering, not a property of the
command.

## `-z`, and splitting on `\0`

With `core.quotePath` on (the default) a path containing a non-ASCII byte
arrives quoted and octal-escaped — `".claude/caf\303\251.mjs"`. That string
matches no declared elevated prefix, so an elevated change records as `normal`.
Separately, a filename containing a newline splits into two junk paths. `-z`
removes both failure modes at once.

## `execFileSync` with an argument array, never a shell string

Nothing in the current command is interpolated into a shell. The point of the
argument array is that the next session cannot start doing so: the safe form has
to be the one already written down, or it will not be the one copied.

## `env: withoutGitLocation()`

Run under a git hook, this command inherits `GIT_DIR` — absolute, when the hook
fired in a worktree — and then resolves against **another repository**.

Measured, from repository A with `GIT_DIR` pointing at an unrelated B:

| form | result |
| --- | --- |
| `<sha>^1 <sha>` — the form pinned above | `fatal: ambiguous argument … unknown revision`, so `execFileSync` throws |
| `HEAD^1 HEAD`, or any `origin/<default>…` form | B's file list, exit 0, nothing wrong-looking |

So for this call, as written, the redirect fails loudly: a sha-to-sha diff is an
object-database lookup, and B either lacks the object (fatal) or shares it and
answers identically. The silent wrong answer needs a **ref that resolves
differently in the other repo** — which is the diff form this record rejects
two sections above.

That is why the argument stays anyway. It costs nothing, it is the same line
every other script here uses, and the moment someone "simplifies" the diff back
to a symbolic ref it becomes the only thing standing between a git hook and a
tier recorded from somebody else's repository.

The sweep that checks `.mjs` sources for this line cannot read markdown, so the
copy inside the rulebook's fenced code blocks is covered by a second sweep over
those blocks. Both live in the generator that produced this project, not here —
if you change the command above, that is the pair to re-check.

## The shape the dangerous ones have

`-z` was the first one that never announced itself: it returned a plausible answer — a
tier of `normal` — and a plausible answer is what a run acts on, with nothing
left behind to say it was never measured.

`ticket` is the second, and it is silent in a narrower way: an id that is
well-formed but belongs to another item excludes THAT item's record, and nothing
in the call can tell. An id the module cannot recognise is reported back, so only
the well-formed wrong id is quiet.

The others are pinned because they are cheap to keep and expensive to
rediscover, not because they all failed the same way. Reading the list as six
silent bypasses is how the two that really are silent stop standing out.

The empty-file-list case is the deliberate counter-example: `recordCompletedTier`
**throws** rather than guessing `normal`, because an absence and a zero look
identical in a count and mean opposite things. That refusal is the behaviour the
loop skill relies on — do not soften it into a default.
