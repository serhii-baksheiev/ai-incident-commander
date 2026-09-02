# ai-incident-commander — plan and work queues

Work in this project has a stated origin, and `.claude/queue.json` names it.
It currently names the `jira` adapter, narrowed to AIC issues labelled
`agent-queue`, so an agent session selects from that board through the `loop`
skill — **not** from the lists in this file. An empty queue still ends the
session; it is never an invitation to improvise.

This file is no longer the queue. It is kept for the standing conventions below
and for the journal pointer, and the two lists remain as the fallback shape the
`plan-md` adapter would parse if `.claude/queue.json` named it again.

## Agent queue

**Not the agent's source of work.** Only the `plan-md` adapter reads the list
below, and `.claude/queue.json` names `jira`, so a line added here is picked up
by nothing. Re-aiming it is a config change, not a fallback the loop reaches on
its own: an adapter that cannot be resolved is a hard error, and an unreachable
tracker is reported as `queue-unreadable`.

A tracker-backed adapter is also what makes a claim durable. Jira **and GitHub
issues** record an observable `in-progress` transition as `workflowClaim`;
PLAN.md stays `open` because it has no such transition to observe. The mechanism
and the tests behind it are in `.claude/skills/loop/SKILL.md`, "Selection is the
first point of the one revalidation chain".

<!-- Parsed only when queue.json names plan-md. One line each, e.g.:
- add a GET /notes/:id route through every layer (TDD)
-->

## Operator queue

Under the `jira` adapter this list is not read either. Work that needs a human
decision is proposed as a `triage`-labelled issue on the board, which the
adapter excludes from selection.

<!-- Parsed only when queue.json names plan-md. State what is needed, e.g.:
- decide: retention policy before real data (RemovalPolicy flip)
-->
## Where the journal is

`journal/YYYY-MM.md` — one file per month, newest-on-top inside each. The
convention and the field list are in `journal/README.md`.

The heading here is deliberately **not** `## Journal`: a pointer under that name
still sends a session into this file to look, and keeping this file small is the
point. `plan-md.mjs` resolves the two queue headings above by name and is not
affected either way.
