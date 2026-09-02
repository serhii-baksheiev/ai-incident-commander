# The AIC-63 resource-evidence read-back, and what it measured

AIC-63's acceptance list ends with a line no local test can satisfy: *"Native
LangSmith calibration read-back shows the new fields on the same applicable
calibration examples."* A test in this repository drives a capturing fake, so it
proves what this code sends — never what LangSmith stores or returns. This record
exists because a claim about a third-party system needs an artifact, and a
sentence in an architecture document is not one.

## What was run, and under what authority

The owner authorised a live write to a calibration project for exactly this
purpose. That authorisation was given in the working session and is recorded in
the PR that carries this change (#41), not in a tracker field — so a reader who
was not there has the run's account of it and the PR's, and nothing stronger.
Saying so is the point: the alternative is a decision record that reads as if
consent were independently attested when it is not. Two experiments were written, both over the **calibration** partition
only — the hold-out was not run, and neither experiment touched the existing
`aic17-*` calibration history.

| project | what it covered |
| --- | --- |
| `aic63-calibration-resource-evidence-080010` | `outputs.resources`, before the feedback surface existed |
| `aic63-calibration-resource-feedback-084842` | both surfaces, after per-axis feedback landed |

The second supersedes the first. Both used deterministic replay nodes — there is
no LLM execution path in this repository, which is why `declaredLlmCallsUsed`
reads what a node declared rather than what a provider spent.

## What came back

Read back through `POST /runs/query` and `GET /feedback`, not asserted from the
write results:

```
project aic63-calibration-resource-feedback-084842 — 24 runs
outputs.resources present: 24 of 24, all seven fields
axes: declaredLlmCallsUsed, logicalIterationsUsed, resumeCount, retryCount,
      schemaVersion, toolCallsUsed, wallClockDurationMs
undeclared / canary fields: 0

feedback, one run: 10 keys
  challenge_effect=0          evidence_coverage=0
  termination_correctness=0   unsupported_claim_rate=0
  declaredllmcallsused=5      logicaliterationsused=2
  toolcallsused=3             wallclockdurationms=9
  retrycount=0                resumecount=0
```

Three things this establishes, none of which a local test could:

1. **The axes survive the round trip separately.** Six resource keys and four
   quality keys, none merged, none dropped.
2. **LangSmith lower-cases feedback keys.** `declaredLlmCallsUsed` is stored and
   returned as `declaredllmcallsused`. The mapping stays unambiguous — no two
   axes collide once lower-cased, and none collides with a quality key — but a
   reader searching the feedback stream for the camelCase name will not find it.
   `outputs.resources` preserves the names as written, which is one more reason
   it is the authoritative surface.
3. **`wallClockDurationMs` is genuinely measured.** The first experiment returned
   8 distinct durations across 24 runs; a constant would have returned one.

## Two operational facts worth keeping

- **The LangSmith SDK retries a successful `createDataset` and then fails its own
  retry with 409.** The first write attempt appeared to fail while having
  succeeded. A one-off probe worked around it by reusing the existing dataset;
  no product code was changed for it.
- **Example identities are stable**, so re-uploading them into a dataset that
  already holds them is a 409. A repeated read-back needs a fresh dataset name,
  not a fresh run id.

## What this record does not establish

It says nothing about whether the numbers are *correct* — only that they cross
the boundary intact and come back separable. `declaredLlmCallsUsed`,
`toolCallsUsed` and `retryCount` are node-originated (§14), so in a benchmark
they are as trustworthy as the fixture that produced them, here and everywhere
else.
