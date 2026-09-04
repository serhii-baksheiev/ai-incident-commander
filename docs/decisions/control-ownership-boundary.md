# Where the graph refuses a control field it does not own — and why not at the serde

The invariant this serves is a **product** one, not a process rule, and it is
worth saying where it actually lives: `humanReview` is what the
`propose_conclusion` edge routes on and what `assertInteractiveRunIdentity`
gates, `IncidentStateControlSchema` in `packages/domain` declares it required,
and `test/hitl-conclusion-review.test.mjs` is where "a run under review does not
finish without one" is pinned. Nothing in `.claude/rules/` says it; the rulebook
governs how work is done here, not what this graph guarantees.

The mechanism is in `packages/graph/src/investigation.ts`. This file is the part
that is a *decision* rather than a mechanism: AIC-92 had several candidate
remedies, some were taken and one was not, and two of the ones taken were wrong
on their first attempt in ways worth recording. It is not loaded into any
session.

## What was actually wrong

Four tickets, in order, and the shape of the mistake they share:

| ticket | what it added | what it covered |
| --- | --- | --- |
| AIC-87 | `assertOwnControlFields` at `parseInvestigationExecutionInput` | the `kind: 'start'` control |
| AIC-89 | the same call in `execute`, on the restored control | what `graph.getState` deserialized |
| AIC-90 | the same call in `reviewConclusion` | what `graph.invoke` deserialized, second copy |
| AIC-92 | an own-property read inside `pickGraphOwnedControl` | a value the prototype **supplies on read**, wherever the route came from |

The first three are **refusal sites**. Each asks "does this object own its
fields" of one object, at one moment. `pickGraphOwnedControl` sat downstream of
all of them doing this:

```ts
defineOwnValue(picked, field, control[field]);   // [[Get]] in, own property out
```

A value the prototype supplied went in unowned and came out **owned**. So a
route reaching a wrapped lifecycle node without passing a refusal site did not
merely evade one check — it manufactured a control that satisfied every check
after it. Three sites, and the class stayed open, because the sites were never
what decided ownership.

The general lesson worth carrying: **a guard that normalises its input defeats
the guards downstream of it.** A fourth site would have been the fourth instance
of the same mistake.

## The routes, and why the primitive was the fix

Two reached it, both through `createInvestigationGraph`'s own API:

1. **A stale `interruptId`.** A resume naming an interrupt the run had moved
   past replayed the thread's pending task — a wrapped node — with
   `reviewConclusion` never running. Measured on `d8bdea1`: pause, reject, a
   node fails transiently, retry the same id with `Object.prototype.humanReview`
   armed as an accessor returning `false` at each microtask turn — turns 1-33
   refused, **34-175 substituted**, 176+ clean.
2. **A caller-supplied node calling `interrupt()`.** Resuming it re-enters at
   that node, which is wrapped, with a **pending** id.

"Substituted" is the outcome worth naming precisely, because a parse-based
oracle scores it as clean: the run completes, `humanReview: false` reaches disk,
the control **parses**, and the review node never runs again. AIC-90 fixed a
*corrupt* control, which anything reading it back can at least see. This one
leaves nothing behind.

Route 2 is why the fix went into the primitive rather than onto route 1.
Closing route 1 alone leaves the same laundering reachable by a caller who
writes a node that pauses itself — and closes nothing about the third route
nobody has found yet.

## Two mistakes made on the way, both found by the gates

Recorded because each is easy to make again and neither is visible from the
finished code.

**The refusal was first conditioned on the value still being reachable.** The
guard read `if (field in control && !OPTIONAL_CONTROL_FIELDS.has(field))`. That
fails open, and `security-scanner` demonstrated it end to end: the mechanism is
a swallowed *write*, so a setter that takes the deserializer's one assignment
and then deletes itself leaves the field **absent with a pristine prototype**.
`field in control` is then false, the field lands as an own `undefined`, and for
`humanReview` that is what the attacker wanted — falsy at the routing edge, an
early return out of the identity check, and now OWN, so it shadows anything the
prototype could still carry. The invariant is presence as an own data property,
full stop; reachability at the moment the guard happens to look is not part of
it.

**The stale-`interruptId` refusal first made crashed runs unresumable.** The
first version refused whenever the named interrupt was not pending and the
thread had any pending task. `code-reviewer` probed the consequence: a run whose
lifecycle node threw — or whose process died mid-superstep — has a pending task
and **zero** pending interrupts, so every id a caller could send was refused,
and `execute` exposes no replay that carries no interrupt id, `getState` is
read-only, and `kind: 'start'` overwrites the control. On `main` that same call
recovered the run. A recovery path was being removed as a side effect, and
nothing in the change recorded it — which is the part that made it a defect
rather than a trade.

The narrower rule is about answering the **wrong** question rather than about
ownership: a decision naming an interrupt while the run waits on a *different*
one is refused, because it answers a question that has already been replaced. A
run waiting on **no** interrupt is still resumable, and a finished run's resume
stays the no-op that resolves. Nothing is given up, because the substitution
that route reached is closed at the primitive.

## The remedy that was not taken: a define-semantics serde

The substitution survives deserialization because
`JsonPlusSerializer._reviver` in `@langchain/langgraph-checkpoint` builds
`const revivedObj = {}` and **assigns** each key into it. An inherited setter
swallows the write, no own property is created, and every later read falls
through to the getter. `JSON.parse` itself uses define semantics and would have
preserved the own value; the loss is one line, after the parse.

The serde is an injection point, not a fork — `BaseCheckpointSaver` takes one in
its constructor and `.serde` is a public assignable field, verified in
`node_modules/@langchain/langgraph-checkpoint/dist/base.d.ts`.

**It was not taken in AIC-92, on two grounds that still hold and one that turned
out not to apply.**

The one that does not apply, and it is worth recording as a mistake rather than
quietly dropping: *"it absorbs the attempt where refusal reports it"*. That was
the primary argument, and it assumes a refusal is available. For the shape the
AIC-92 gate found last, it is not — see the section below. Where nothing can be
detected, "immunity versus reporting" is not a choice being made.

The two that stand are costs rather than blockers:

1. **It puts the check on the far side of a boundary.** Ownership of graph-owned
   control is the graph's invariant. Enforcing it in `packages/persistence`
   makes the guarantee depend on which checkpointer a caller wired up, and a
   caller passing their own `BaseCheckpointSaver` would silently lose it.
2. **It makes this repository own behaviour the dependency may change**, plus a
   second parse per load. The fix is obvious enough that upstream may well make
   it, leaving a module here compensating for something that no longer happens,
   with nothing to say so.

What AIC-92 did settle is the *ordering*: the graph refuses what it can see, at
the primitive, and that stands whether or not a serde lands later. What must not
happen is the serde arriving and the refusal rows being deleted to make room for
it — they cover a different half, and hitl-resume-contract.test.mjs › "refuses
the pollution armed at a turn inside the measured window" is where that half is
pinned.

## What none of this closes, and why it needed its own ticket

Every guard here asks whether a field is the run's **own data property**. A
prototype gadget can make that honestly true while choosing the value, by
defining it on the target from its setter:

```js
Object.defineProperty(Object.prototype, 'humanReview', {
  configurable: true,
  get() { return false; },
  set() {
    Object.defineProperty(this, 'humanReview',
      { value: false, writable: true, enumerable: true, configurable: true });
  },
});
```

The reviver's assignment fires the setter, which defines `false` as the target's
own property. Measured on `bd974ed` and identically on `main`: the resume is not
refused, the run completes, `review_conclusion` never runs again, and the
persisted control **parses** — the substituted outcome, with nothing on disk
recording it.

No ownership check closes this, because there is nothing left to detect. The
remedy is the serde after all, and for a reason the section above did not have:
measured with the gadget armed, `JSON.parse('{"humanReview":true}')` yields an
own `true` while `o.humanReview = true` yields an own `false` — define semantics
never invoke the setter. That is **AIC-93**, split out rather than folded in
because it lives in `packages/persistence` and is a different layer's
responsibility.

The limit is pinned rather than described: hitl-resume-contract.test.mjs ›
"documents the limit: an inherited setter that writes an own property is not
refused" asserts the current unsafe outcome on purpose, so that closing it turns
a row red and forces the claims here to be updated.

## Two checks on the resume path, and why they are not one

`assertOwnControlFields` asks only that a field which is **present** be own.
That is the right question for a `kind: 'start'` state, where a field missing
entirely must produce the schema's parse error rather than an ownership
complaint. A restored control has been parsed once already, so a required field
missing from it is not an omission — it is damage.

`assertRestoredControlFieldsPresent` is therefore a second check, in
`reviewConclusion`. ⚠ Not "resume-only", though that is what it is for: that
node's prologue also runs on the initial visit, before `interrupt()` throws, so
the check runs on a run nobody has resumed. Harmless — an initial control that
passed `IncidentStateSchema` carries every required field — but its message says
"the restored control", which on that path names something that was not
restored.
It matters because `pickGraphOwnedControl` alone is not enough on every route: a
`confirm` reaches END from `reviewConclusion` without entering a single wrapped
node, and before this check a `confirm` on a control whose `humanReview` had
been erased **completed the run** and wrote a control the domain schema rejects.

It runs **after** `assertPersistedStateVersion` and must never move above it.
"Required" is a fact about the *current* schema, so a checkpoint written by an
older one is missing fields legitimately and has to be refused for being stale.
Moving that one line up replaces six version-boundary refusals with an ownership
complaint about the first counter the older schema had not invented yet.

## The one place the fix is immunity rather than refusal

`pickGraphOwnedControl` refuses a required graph-owned field that is not an own
data property — **unless the schema lets that field be absent**. Today that is
`stopKind` and only `stopKind`, but the set is asked of
`IncidentStateControlSchema` rather than written down.

The question it asks is deliberately narrower than "does the parse succeed". A
schema accepts `undefined` for `.default(x)`, `.catch(x)`, `z.any()` and
`z.unknown()` as well as for `.optional()`, so the classification also requires
the parse to *yield* `undefined`. Without that, a graph-owned field gaining a
default would stop being refused and instead land `undefined`, be dropped by
JSON, and be re-read as the default — for `humanReview`, the review gate quietly
resetting itself, which is this ticket's own failure mode downgraded from loud
to silent.

The asymmetry is real rather than cosmetic. For a required field, missing as an
own data property cannot describe a healthy control. For an optional one,
absence is the normal shape of a run that has not stopped, and nothing can
distinguish "the caller omitted it" from "the caller omitted it and someone
armed the prototype". So the prototype is not consulted and the field lands
`undefined`. Neither branch lets a value the prototype **supplies on read**
reach the control; the difference is only whether the attempt is reported. (A
value an inherited setter *writes* is a different matter, and the section above
says so.)

Refusing the optional half would also break a contract that predates this work:
graph-owned-control-contract.test.mjs › "keeps graph-owned control intact while
Object.prototype carries a setter of that name" requires a run to survive an
inherited accessor on **every** graph-owned field and write the control it would
have written anyway.

⚠ One thing here is general and one is not. The classification is derived; the
handling downstream is not — `preserveGraphOwnedControl` destructures `stopKind`
by name and restores it only when it carries a value. A second optional
graph-owned field would land `undefined` here and be spread as `undefined`
there. Survivable, and not what the derivation would lead a reader to expect;
whoever adds one owns that line too.

## What changed for callers

A resume naming an interrupt while the thread waits on a **different** one is
now refused by name. It used to replay the pending task with the resume map
unmatched and hand back whatever interrupt was already there, which a caller not
comparing interrupt ids read as success.

Unchanged, deliberately, and each pinned by a row: a run waiting on **no**
interrupt — the shape a thrown lifecycle node or a dead process leaves — is
still resumable, because a resume is the only way to advance it; and a
**finished** run's resume stays a no-op that resolves, since refusing it would
be a false statement about a thread that has a checkpoint and a real state.
