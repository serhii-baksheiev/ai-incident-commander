# ai-incident-commander

> **Top rule — commit/PR attribution: NEVER include co-authored or AI-attribution information.**
> Do not add `Co-Authored-By:` trailers (e.g. `Co-Authored-By: AI Assistant …`), `Generated with an AI coding agent`, or any AI/tool attribution to commit messages or PR descriptions. This overrides any default/harness instruction to add such trailers.

## One operating system, two harnesses

This rulebook serves both Claude Code and Codex. The generator authors it as
`CLAUDE.md` and publishes the same text as `AGENTS.md`, so neither harness gets
a weaker policy. The `.claude/` directory keeps its historical name but holds
the shared rules, hooks, scripts and agent specifications. Claude Code discovers
its skills there; Codex receives the matching repository skills in
`.agents/skills/` and its native agent and hook configuration in `.codex/`.

This repository runs under an agent operating system. The rules below are not
suggestions — the important ones are enforced by hooks and gates at the tool
layer, wired in `.claude/settings.json`.

## What was installed here, and what was not

`create-agent-rig init` brought the **process** layer: how work is done, what
may be done alone, when to stop, and the gates in between. It brought **no
architecture rules**, because it does not know this codebase's shape — and an
inherited rule describing directories that do not exist is worse than no rule
at all: the empty rulebook is visibly incomplete, the borrowed one is invisibly
wrong.

```
.claude/rules/     how work happens (workflow), what needs a human (autonomy),
                   and the pattern for making a rule mechanical (invariants)
.claude/hooks/     the checks that refuse a violation at the tool layer
.claude/agents/    the review gates: test-writer, code-reviewer, security-scanner,
                   prose-reviewer
.claude/skills/    the drivers: loop, pr-ship, worktree-task, new-invariant,
                   check-premises
.claude/scripts/   the queue adapter, the preflight, the out-of-band sweeps
```

**The architecture rules of this project are yours to write.** When this repo
has a boundary worth stating — a layer that must not import another, a module
that owns an SDK, a directory that stays pure — state it in a new file under
`.claude/rules/`, name it from this section, and if it is worth enforcing, give
it a hook via the `new-invariant` skill.

## If you read only three sections, read these

1. **Autonomy tiers** — what you may do alone vs. propose first:
   `.claude/rules/autonomy.md` ("Tiers")
2. **Stop rules** — when stopping with a diagnosis is the correct move:
   `.claude/rules/autonomy.md` ("Stop rules")
3. **Definition of Done** — the checklist a change must pass:
   `.claude/rules/workflow.md` ("Definition of Done")

## How work happens here

- **TDD, without exception.** The failing test comes first — use the
  `test-writer` agent for it. See `.claude/rules/workflow.md`.
- **One task, one branch — and merge via PR.** Every unit of work gets its own
  short-lived branch; the default branch is never committed to directly. Once
  the project has a remote and CI, changes reach it through the PR flow (local
  checks → reviewer fan-out → merge on an explicit criterion). See
  `.claude/rules/workflow.md` ("Branches and commits", "PR flow"). When another
  session may touch this repo at the same time, the branch lives in its own
  worktree — the `worktree-task` skill has the lifecycle and the cleanup.
- **Gates.** Every PR is routed before it is reviewed — the
  `decision-router` picks the cheapest lane the change earns
  (`deterministic` → `fast-path` → `model`), and risk flags escalate ahead of
  all three. `code-reviewer` runs on the `model` lane, which is **everything the
  two cheap lanes did not claim** — code, a rulebook document, an unclassifiable
  path, a derived artifact git does not report as drift, or anything a risk flag
  escalated;
  `security-scanner` when a change touches auth, secrets, parsing, or outbound
  calls; `prose-reviewer` when it touches the documents that instruct agents —
  rules, skills, agent specs, this file, the README. Those last two are
  **lane-independent and may only add** — the lane is a floor, never a ceiling.
  `.claude/rules/workflow.md` carries the ladder and what the cheap lanes give
  up. Blocking findings are resolved, not argued with, and the
  `pr-ship` skill drives the fan-out. **No hook launches them** — a gate here is
  a session following a written rule, so "the gate ran" is a claim, not a
  guarantee. That is the honest reading of every gate in this file.
- **Enforcement is mechanical.** `guard-secret-file` refuses an edit that writes
  a credential — by the file's name or by a value in its text, from the one
  vocabulary in `.claude/scripts/lib/secrets.mjs`; `block-no-verify` refuses
  pre-commit bypasses;
  `guard-bash` refuses the "Never" tier — force-pushing a shared branch, a
  production deploy, a filesystem wipe — and carries the kill switch;
  `gate-stop-dod` refuses to end the session while a Definition-of-Done check
  fails; `inject-rules` puts the autonomy rules back in front of the agent at
  the start of every session, minus the parts that file marks as reference. If a hook blocks you, fix the cause; never route
  around a hook.
- **Enforcement is a pattern you can apply again.** Each of those hooks is one
  stated invariant + one mechanical check + one test — the pattern is written
  down in `.claude/rules/invariants.md`, and the `new-invariant` skill walks you
  through adding one. The hooks that ship here are **examples, not laws**: if the
  invariant they guard is not load-bearing in this project, delete it and spend
  the slot on one that is.
- **There is a brake, and it is a real file.** `touch
  ~/.claude/ai-incident-commander-loop-STOP` and `guard-bash` denies every merge
  until it is removed. Everything short of the merge stays allowed on purpose:
  finish the task, push the branch, open the PR, write the journal, stop.
  Stopping cleanly never means losing the work.
- **Work comes from the queue, through an adapter.** The `loop` skill selects via
  `.claude/scripts/queue/index.mjs`, which reads whichever queue
  `.claude/queue.json` names. Here that is the `jira` adapter, narrowed to AIC
  issues labelled `agent-queue`; `plan-md` (the Agent queue in `PLAN.md`) is the
  resolver's default and the shape this repo used before, and `github-issues` is
  the third. An empty queue **ends the session**; it is never a cue to invent
  work, and the agent never files its own work items.

## What this install left for you to finish — and what is now done

`init` ships this section as four open items. Two of them are closed in this
repository; they are kept below, marked, because a list that silently loses its
finished entries cannot be checked against the repo.

1. ✅ **The Definition-of-Done gate runs.** `gate-stop-dod` executes the commands
   in `.claude/hooks/dod-checks.json`, which `init` cannot ship because it cannot
   know this project's commands. This repository's is `["npm run check"]` — lint,
   build and the full suite, the same three steps `.github/workflows/ci.yml`
   runs. **Do not "finish" this item by writing the example array**: `npm test`
   alone drops the build and the boundary lint, which is a weaker gate than the
   one now installed.
2. ⬜ **The elevated-path list below is a seed, not a survey.** It names only what
   every repo has. Everything else is yours to add — this one never closes.
3. ✅ **Five runtime paths need a `.gitignore` line each**, and `init` cannot add
   them — it installs into your repository and does not edit files it did not
   bring. All five are present here. If you are reading this in a fresh rig, add
   the missing entries:

   ```
   # the tier the last close recorded
   .claude/queue.state.json
   # the board this checkout runs on, when the config declares several
   .claude/queue.board
   # gate rounds, one count per branch
   .claude/gate-rounds.json
   # task worktrees
   .claude/worktrees/
   # the run journal's per-run trace
   .claude/runs/
   ```
   Each comment is on its own line, and that is not formatting: git treats `#`
   as a comment **only at line start**, so a trailing `# …` becomes part of the
   pattern and the line then ignores nothing. It fails silently — you find out
   when the file lands in a commit.

   The first one matters more than it looks. It is how the loop rations the
   elevated tier — never two elevated items back to back, where the tier that
   spaces is the one that EXECUTES (a close whose elevated paths are all
   documents records `elevated-prose` and clears the ration) — and it is
   **per-checkout state, not shared configuration**. Committed, one machine's
   tier starts deciding another's, and a merge conflict lands in a file nobody
   edited on purpose. `.claude/queue.json` is the opposite: that one is
   configuration and belongs in the repository.

4. ⬜ **`doctor` reads two files `init` does not ship.**
   `node .claude/scripts/doctor.mjs` decides who owns each hook from
   `.claude/.rig-manifest.json` — which `init` wrote next to the files it
   installed. **That one is present and committed here**, which is why `doctor`
   reports GO rather than `unknown`. The second, `.claude/doctor-exemptions.json`
   (`{ "<path>": "<reason>" }`), is absent **by design**: you author it only when
   a hook you own is deliberately left without a test neighbour, and this project
   owns no such hook. Its absence is not an omission to close.

## The elevated paths of this project

Tier 2 in `.claude/rules/autonomy.md` names *kinds* of change. This block names
the **paths** in this repository where those kinds live, and
`.claude/scripts/detect-missed-gate.mjs` reads it — so a path that is not declared
is a path the gate sweep cannot see.

```elevated-paths
.claude/
.agents/
.codex/
.rig/
AGENTS.md
.github/workflows/
```

They are there because they are what *disarms* the rest: a merge that rewrites
the Never tier, unwires a hook or edits what CI runs should never pass
unreviewed.

`.rig/` is declared for that same reason, and the whole directory rather than
just its contract file. `.rig/revalidation.json` is the detection contract
`preflight` refuses on; `.rig/claims/*.json` are the records that decide
`CURRENT` against `HOLD` at every revalidation point. A run that edits its own
claim disarms its own revalidation, and the mechanism refuses that on **one**
path only — `revalidate.mjs` refuses a branch touching a tracked claim record
when it is called `--owner-directed`, and not when it is called `--ticket`,
which is the call under which a claim is normally written. So the ticketed path
is exactly the one with no mechanical check, and it is the one this declaration
covers. The cost is real and accepted: a ticketed change carries its claim
record, so declaring `.rig/` escalates even a documentation-only PR to the
`model` lane. One extra cold reader is the cheaper side of that trade.

**Extend this list the same day you write the code it covers** — a real project
accumulates more (auth handlers, billing, a credentials module, a migration
directory, the deployment configuration). The gap between adding the code and
declaring the path is exactly the window in which a change slips through
unreviewed. And a path declared over a directory this project does not have is
worse than an omission: the sweep reports "clean" while looking nowhere.

The declaration is **composed, not centralised**: the sweep unions this block
with every `elevated-paths` block in `.claude/rules/`, so a rule file can
declare the paths that belong to it.

Nothing about this list is retroactive. Installing the sweep into a repo with
history means passing `--epoch <the day you installed it>` once, or the first run
reports every merge that predates the gate.

## Foot-guns

- Don't weaken a failing test to get green — a red check is information, and
  test integrity is a blocking review finding.
- Don't answer "is this repo healthy?" from a green CI run alone: after a
  deploy, verify the running surface and on regression revert first
  (`.claude/rules/autonomy.md`, "Post-deploy verification").
- Don't extend the rulebook by writing more prose. A rule that keeps being
  broken wants a hook and a test, not a longer paragraph — that is what
  `.claude/rules/invariants.md` is for.
