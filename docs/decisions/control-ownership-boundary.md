# Where the graph refuses a control field it does not own — and where the serde repairs instead

⚠ The title said "and why not at the serde" until AIC-93, which took the serde
after all. The record is kept in order rather than rewritten: read the middle
sections as the reasoning of the time, and the last section as what replaced it.

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
stays the no-op that resolves.

⚠ "Nothing is given up" is what an earlier draft of this paragraph said, and it
was measurably false: the route was a path to the limit the section below
describes, and the row that showed it armed the gadget on this route rather than
on a plain `confirm`. **AIC-93 closed that limit** (last section), so the row now
asserts the safe outcome on the same route — hitl-resume-contract.test.mjs ›
"keeps the run's own humanReview under that gadget on the crashed-run retry
route". What is still given up on this route is the REPORT, not the value. It was
not a path the refusal would have closed — the same gadget reaches a plain `confirm`, which no form of
this refusal ever covered — so refusing here would remove one path to a limit
that stays open regardless, at the price of every crashed run's only way
forward. What the primitive closes on this route is the READ-supplied
substitution, and that is closed either way.

## The remedy that was not taken: a define-semantics serde

⚠ **Superseded by the last section of this record.** It WAS taken, in AIC-93.
The reasoning below is kept because two of its three objections survived as
costs and the third turned out to be the interesting one; what changed, and
why, is at the end.

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

The limit was pinned rather than described, and that mechanism did its job: the
row asserting the unsafe outcome went red the moment AIC-93 closed the limit,
and forced these claims to be rewritten rather than left standing. It now
asserts the safe outcome under the same gadget — hitl-resume-contract.test.mjs ›
"keeps the run's own humanReview under an inherited setter that writes an own
property".

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


## The decision is not control, and needed a different question (AIC-102)

Everything above protects the control the **graph owns**. The human's decision
is the opposite: the one value the graph does not own and must not second-guess.
It needed its own answer, and the ownership idiom this record is built on is not
it.

A prototype gadget on `action` makes `ConclusionReviewDecisionSchema` return
`confirm` for a caller who wrote `reject`. The run then resolves at END,
`review_conclusion` never runs again, zero nodes replay, and the checkpoint
records a completed, reviewed-looking run.

**An ownership check does not separate the two shapes.** Under a read accessor
the parsed `action` is not own, so `Object.hasOwn` would catch it; under a setter
that *defines* on its target the field is genuinely own and carries the
attacker's value, so it would not. What discriminates both is a **comparison**:
the caller's own raw `action`, read as an own data property. An object literal
uses `CreateDataProperty`, so a literal decision keeps its own value under either
gadget.

🔴 **Two things about that comparison were wrong on the first attempt, and both
are the same mistake in different clothes: trusting a read the attacker controls.**

*The right-hand side was a plain `[[Get]]`.* It compared an own read against
`parsed.action`, and when the parse leaves no own `action` behind that goes
through the getter — as does the routing test further down. A getter answering
honestly ONCE and attacker-side afterwards satisfied the guard and then decided
the route. Measured 3/3: a human `reject` resolved the run at END. Two reads of
one property through one getter compare whatever the getter feels like.

*The field list came from the result.* `add_hypothesis` carries a `hypothesis`
the graph writes into state, and with `Object.prototype.hypothesis` armed a
caller sending `{ action: 'add_hypothesis' }` alone PARSES — the strict object
reads the missing field off the prototype. Looping over `Object.keys(parsed)`
sees nothing, because zod never makes that field own: the result's own keys are
`['action']` while `parsed.hypothesis` still hands the graph the attacker's
value. The list has to come from the **schema**, asked through its own options
rather than its internals.

*And the parse output was the third.* Checking the caller's object constrained
nothing about the object the graph acted on: zod builds its result by
**assigning** into a fresh object, which an own-writing setter intercepts, so a
caller sending a complete and honest `add_hypothesis` had the attacker's
hypothesis enter persisted state. That is what ended the checking approach. The
decision the graph acts on is now ASSEMBLED from the caller's own descriptors
with `defineProperty` — which no inherited setter can intercept — and validated
against a copy with no prototype, so an omitted field is refused rather than
filled in.

Two consequences worth recording. The remaining comparison is **detection only**;
correctness is settled by the assembly, which is why removing the comparison
reddens rows about *reporting* rather than about substitution. And the earlier
declared-field loop and `undefined` refusal became unreachable and were deleted
rather than pinned — measured, neutering either reddened nothing. A guard that
cannot fail is not a guard.

⚠ **What the assembly gives up, stated because this record otherwise reads as
though every attempt is reported.** Only the discriminant is compared, so a
substitution aimed at a non-discriminant field — an own-writing
`Object.prototype.hypothesis` against a caller who supplied a complete, honest
one — now proceeds silently with the caller's value. Correct value, no report.
That is a step back from AIC-92's convention and a large step forward from
`main`, which took the attacker's value and reported nothing; the declared-field
check that would have reported it was deleted because, once the validated copy
lost its prototype, it could no longer fail.

A guard that reads its subject the way the subject wants to be read is not a
guard. That is the same sentence as "a guard that normalises its input defeats
the guards downstream of it", from the top of this record, arrived at from the
other direction.

WARNING — **the precondition is warmth, and the cold path is not a defence.**
`ConclusionReviewDecisionSchema` is a discriminated union whose `propValues`
lookup zod builds lazily and memoises. Built while the gadget is armed,
`propValues['action']` reads `'confirm'` through the getter — not nullish — so
the `Set` is never created and `.add` throws. That looks protective and is zod
crashing on the pollution; one ordinary prior decision parse removes it, which
is the steady state of any long-lived process after its first review. A test
that relied on file ordering to supply that warmth would pass or fail by
accident, so the rows arm it explicitly.

**Both parse sites are guarded, and neither is redundant** —
`parseInvestigationExecutionInput` runs synchronously before `execute`'s first
await, so a gadget armed one microtask later is invisible to it and lands on
`reviewConclusion`'s parse instead. Measured with the node-side check removed:
every turn from 1 to 10, on both shapes, executes the human's rejection as a
confirm. That is the AIC-90 two-read shape again, on the decision rather than
the control, and it is why the guard is duplicated rather than centralised.


## The serde after all, and what reversing the trade actually bought (AIC-93)

The section above named a remedy and declined it. AIC-93 took it.
`withDeclaredOwnValues` in `packages/persistence` wraps the checkpointer's
serde, and `createSqliteCheckpointer` — the only place this repository builds a
checkpointer — wires it, so every call site is covered by one line.

**Why the trade reversed, in one sentence:** the objection that carried it was
about a choice that does not exist for this shape.

*"It absorbs the attempt where refusal reports it"* was AIC-92's primary
argument, and it is a real argument wherever a refusal is available. It is not
available here. An inherited setter that answers the reviver's assignment by
`Object.defineProperty(this, k, { value })` leaves a genuine own data property
carrying the attacker's value; every check in `packages/graph` asks whether the
field is the run's own data property and gets an honest yes. There is nothing
left to detect, so "immunity versus reporting" is not a choice being made — the
alternatives were immunity and nothing.

**The other two objections stand, unmodified, as accepted costs.**

1. The check is on the far side of a boundary. Ownership of graph-owned control
   is the graph's invariant, and enforcing it in `packages/persistence` makes
   the guarantee depend on which checkpointer a caller wired up. **A caller who
   passes their own `BaseCheckpointSaver` to `createInvestigationGraph` still
   loses this entirely** — measured rather than asserted:
   checkpoint-serde-own-values.test.mjs › "states its limit: a checkpointer this
   module did not build keeps the unrepaired serde".
2. This repository now owns behaviour the dependency may change, plus a second
   parse per load. The fix is obvious enough that upstream may make it, leaving
   a module here compensating for something that no longer happens.

### The load-bearing part: it repairs only a diverged own data property

An unconditional "make every loaded value match the serialized form" also
repairs the shapes the graph deliberately refuses — a slot an inherited setter
SWALLOWED, and an own ACCESSOR a setter defined on the target. Measured on the
merged head, and these are ALL of the rows it reddens rather than a sample:

* `hitl-resume-contract.test.mjs` › "refuses a resume whose restored control
  field is supplied by an accessor on the prototype"
* `hitl-resume-contract.test.mjs` › "refuses the pollution armed at a turn
  inside the measured window"
* `hitl-resume-contract.test.mjs` › "refuses the value a stale retry launders
  into a wrapped node"
* `checkpoint-serde-own-values.test.mjs` › "leaves a swallowed write for the
  graph to refuse rather than repairing it"

Four rows, seventeen subtests — and here is how to get that number back, because
a count with no recipe is a count the next reader cannot check. Make
`restoreSlot` repair regardless of `slot.present` (drop the `present` guard on
the leaf branch), rebuild, and run the whole suite: exactly these four rows go
red, seventeen subtests among them. Re-measured at the AIC-93 gate by
`code-reviewer` against the full suite, and it reproduced exactly.

An earlier draft of this section said "five rows, including …" and cited three of
them; that count was never measured and the word "including" conceded the list
was partial, which is the shape a later reader cannot check. The list above is
the whole answer, so a rerun that returns anything else means the guard moved.

That is exactly the outcome the ordering paragraph above forbids: the serde
arriving and the refusal rows being deleted to make room for it.

So the condition is one line and it is the whole design. A slot is repaired only
when the reviver left it as an **own data property whose value diverged from the
serialized form**. An absent slot stays absent and an own accessor stays an
accessor, so the graph keeps refusing them and the two mechanisms divide by
shape rather than by preference:

| what the reviver left | who answers it | the caller sees |
| --- | --- | --- |
| own data property, value diverged | the serde | the run's own value, silently |
| slot absent | the graph's refusal sites | a refusal naming the field |
| own accessor | the graph's refusal sites | a refusal naming the field |


### Stated plainly: on a leaf the run is made immune, not refused

**This section is about the LEAF shapes only.** Where the serialized form
declares a container and the loaded side offers nothing to check it against,
the module refuses instead — limit 9 in the module's header, added at the
AIC-93 gate after a container-key accessor was shown carrying
`humanReview:false` through a real `confirm` resume, parse-clean.
see `hitl-resume-contract.test.mjs` › "refuses a resume when a container key hides the control behind an own accessor, and leaves the checkpoint the run's own values"

The reason the two halves differ is that the graph's refusal sites cover the
leaf fields and cover no container at all.

For a leaf, then: no new refusal reaches an operator on that shape, and
**nothing on disk records the attempt**. A run resumed with the gadget armed completes on the control the
checkpoint bytes declare, and looks exactly like a run nobody attacked. That is
a genuine step back from this record's own convention that an attempt should be
reported, and it is taken because the alternative was not reporting — it was the
substitution succeeding.

### The module's limits are NOT restated here

They live in one place — the numbered list in the header of
`packages/persistence/src/own-value-serde.ts`, each entry ending in the test row
that pins it. An earlier version of this section enumerated "two further
limits"; the module then grew to nine, and this copy went stale without anything
going red, which is the exact failure mode a second spelling of one fact
produces. Read the header.

Two of them matter enough to this record's argument to name, and naming them
means pointing at the rows rather than restating what they do:

* `checkpoint-serde-own-values.test.mjs` › "refuses a checkpoint value nested
  deeper than DESERIALIZATION_MAX_DEPTH" and › "accepts a value just inside both
  bounds" — the bound, pinned in both directions, so it cannot be satisfied by
  refusing everything.
* `checkpoint-serde-own-values.test.mjs` › "states its limit: a polluted key
  inside a Map member is not repaired".

Nothing in `IncidentStateControlSchema` is stored inside a `Map` or `Set` today.
