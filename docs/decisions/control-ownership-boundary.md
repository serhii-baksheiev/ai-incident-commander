# Where the graph refuses a control field it does not own — and why not at the serde

The rule this serves is in `.claude/rules/autonomy.md` ("Never" — a run must not
complete with the human-review gate disarmed) and the mechanism is in
`packages/graph/src/investigation.ts`. This file is the part that is a
*decision* rather than a mechanism: AIC-92 had three candidate remedies, two of
them were taken and one was not, and the one that was not is the interesting
one. It is not loaded into any session.

## What was actually wrong

Four tickets, in order, and the shape of the mistake they share:

| ticket | what it added | what it covered |
| --- | --- | --- |
| AIC-87 | `assertOwnControlFields` at `parseInvestigationExecutionInput` | the `kind: 'start'` control |
| AIC-89 | the same call in `execute`, on the restored control | what `graph.getState` deserialized |
| AIC-90 | the same call in `reviewConclusion` | what `graph.invoke` deserialized, second copy |
| AIC-92 | an own-property read inside `pickGraphOwnedControl` | the value, wherever it came from |

The first three are **refusal sites**. Each one asks "does this object own its
fields" of one object, at one moment. `pickGraphOwnedControl` sat downstream of
all of them doing this:

```ts
defineOwnValue(picked, field, control[field]);   // [[Get]] in, own property out
```

A value the prototype supplied went in unowned and came out **owned**. So a
route that reached a wrapped lifecycle node without passing a refusal site did
not merely evade one check — it manufactured a control that satisfied every
check after it. Three sites, and the class stayed open, because the sites were
never the thing that decided ownership.

That is the general lesson worth carrying: **a guard that normalises its input
defeats the guards downstream of it.** Adding a fourth site would have been the
fourth instance of the same mistake.

## The routes, and why the primitive was the fix rather than the routes

Two reached it, both through `createInvestigationGraph`'s own API:

1. **A stale `interruptId`.** `execute` computed `targetsPendingInterrupt` and
   used it only to gate one extra assertion, so a resume naming an interrupt the
   run had moved past replayed the thread's pending task — a wrapped node — with
   `reviewConclusion` never running. Measured on `d8bdea1`: pause, reject, a node
   fails transiently, retry the same id with `Object.prototype.humanReview`
   armed as an accessor returning `false` at each microtask turn — turns 1-33
   refused, **34-175 substituted**, 176+ clean.
2. **A caller-supplied node calling `interrupt()`.** Resuming it re-enters at
   that node, which is wrapped, with a **pending** id — so remedy 1 does not
   touch it. `InvestigationNode` does not declare `interrupt()`; nothing refused
   a node that called it.

"Substituted" is the outcome worth naming precisely, because a parse-based
oracle scores it as clean: the run completes, `humanReview: false` reaches disk,
the control **parses**, and the review node never runs again. AIC-90 fixed a
*corrupt* control, which at least anything reading it back can see. This one
leaves nothing behind.

Route 2 is why the fix went into the primitive. Closing route 1 alone would have
left the same laundering reachable by a caller who writes a node that pauses
itself; closing the primitive closes both, and closes the third route nobody has
found yet.

## The remedy that was not taken: a define-semantics serde

The substitution survives deserialization because
`JsonPlusSerializer._reviver` in `@langchain/langgraph-checkpoint` builds
`const revivedObj = {}` and **assigns** each key into it. An inherited setter
swallows the write, no own property is created, and every later read falls
through to the getter. `JSON.parse` itself uses define semantics and would have
preserved the own value; the loss is one line, after the parse.

The serde is an injection point, not a fork — `BaseCheckpointSaver` takes one in
its constructor and `.serde` is a public assignable field — so injecting one in
`packages/persistence` that re-owns from `JSON.parse` was roughly 25 lines, and
it was measured to work: zero refusals and zero substitutions at every arming
turn on all three resume routes.

**It was rejected, and on three grounds, in descending order of weight:**

1. **It absorbs the attempt where refusal reports it.** A repaired control is
   indistinguishable from one that was never attacked. This repository's own
   test says so out loud, in the header of
   hitl-resume-contract.test.mjs › "refuses the pollution armed at a turn inside
   the measured window": a fix that made the resume immune instead "would
   complete cleanly and redden this row… choosing immunity over refusal is a
   caller-visible decision about whether an attempted substitution is reported."
   Taking the serde would have meant deleting that assertion — which is exactly
   the shape this project refuses to call a fix.
2. **It puts the check on the wrong side of a boundary.** Ownership of
   graph-owned control is the graph's invariant. Enforcing it in
   `packages/persistence` makes the graph's guarantee depend on which
   checkpointer a caller wired up, and a caller passing their own
   `BaseCheckpointSaver` would silently lose it.
3. **It makes this repository own behaviour the dependency may change**, plus a
   second `JSON.parse` per load. A minor upgrade to the reviver — the fix is
   obvious enough that upstream may well make it — would leave a module here
   compensating for something that no longer happens, and nothing would say so.

The two are not mutually exclusive, and the door is left open: if a future
version of this system needs the substitution to be *unrepresentable* rather
than *refused*, the serde is where that goes, and the ownership checks stay as
tripwires that should then never fire. What must not happen is the serde landing
quietly and the refusal rows being deleted to make room for it.

## The one place the fix is immunity rather than refusal, and why

`pickGraphOwnedControl` refuses a field that is reachable on the prototype chain
but not own — **unless the schema lets that field be absent**. Today that is
`stopKind` and only `stopKind`, but the set is asked of
`IncidentStateControlSchema` rather than written down, so a field that gains or
loses optionality carries the classification with it.

The asymmetry is real rather than cosmetic. For a required field, "absent as an
own property while reachable through the prototype" cannot describe a healthy
control — it *is* the substitution. For an optional one, absence is the normal
shape of a run that has not stopped, and nothing can distinguish "the caller
omitted it" from "the caller omitted it and someone armed the prototype". So the
prototype is not consulted, the field lands `undefined`, and the wrapper
restores it only when it carries a value. The attacker's value reaches the
control in neither case; the difference is only whether the attempt is reported.

Refusing the optional half would also have broken a contract that predates this
work: graph-owned-control-contract.test.mjs › "keeps graph-owned control intact
while Object.prototype carries a setter of that name" requires a run to survive
an inherited accessor on **every** graph-owned field and write the control it
would have written anyway. That row was written for AIC-73 and is about the
wrapper, not about resumes; on the start path, where every required field
carries its own value, nothing is being substituted and there is nothing to
report.

## What changed for callers

A resume naming an interrupt that is no longer pending, on a thread that still
has pending work, is now **refused by name** instead of resolving. It used to
replay the pending task with the resume map unmatched and hand back whatever
interrupt was already there, which a caller who did not compare interrupt ids
read as success.

The condition carries `tasks.length > 0` deliberately. A **finished** run has no
pending task and no pending interrupt either, and resuming one stays a no-op
that resolves — refusing it would be a false statement about a thread that has a
checkpoint and a real state. That contract is pinned in
hitl-resume-contract.test.mjs › "resolves a resume of a run that already
finished, rather than calling it a missing checkpoint", and it is the row that
stops the refusal from being widened into it.
