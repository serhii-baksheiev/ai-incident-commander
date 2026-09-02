# ai-incident-commander — plan and work queues

Work in this project has a stated origin: one of the two queues below. An
agent session picks from the **Agent queue** (see the `loop` skill); anything
that needs a human decision waits in the **Operator queue**. An empty Agent
queue means the session ends — it is never an invitation to improvise.

Keep entries one line each, most valuable first. Delete done items — the
journal records history; the queues state only what is next.

## Agent queue

**This queue is no longer the agent's source of work.** `.claude/queue.json`
names the `jira` adapter on project `AIC`, so the `loop` skill selects from Jira
issues and never reads the list below. Two things follow: a line added here is
picked up by nothing, and a Jira ticket is what an agent can actually claim —
only the Jira adapter writes the durable `workflowClaim` that the revalidation
chain needs, which `plan-md` cannot do at all.

<!-- Kept as the fallback the adapter would read if queue.json named plan-md
     again. One line each, e.g.:
- add a GET /notes/:id route through every layer (TDD)
-->

## Operator queue

<!-- Decisions and Tier-2 work waiting on a human. State what is needed, e.g.:
- decide: retention policy before real data (RemovalPolicy flip)
-->
## Where the journal is

`journal/YYYY-MM.md` — one file per month, newest-on-top inside each. The
convention and the field list are in `journal/README.md`.

The heading here is deliberately **not** `## Journal`: a pointer under that name
still sends a session into this file to look, and keeping this file small is the
point. `plan-md.mjs` resolves the two queue headings above by name and is not
affected either way.
