# Incident Lab

The Incident Lab is an isolated live-system surface for controlled
investigation. Its Docker-backed lane is separate from ordinary tests and
checks. See `test/incident-lab-operator-contract.test.mjs` › "keeps Docker live
work outside ordinary test and check lanes".

## v0.1 scenario lab

The version 2 lab topology contains `api`, `payments`, and `inventory` services.
Only the unauthenticated control and observation API is published to the host,
and Compose binds it to `127.0.0.1`. The other services are reachable only on
the private Compose network. See `incident-lab/tests/aic16-completion.live.mjs`
› "declares the bounded three-service topology and publishes only the loopback
API".

The lab reproduces the observations for all five frozen v0.1 scenarios:

- `bad-deployment` v1;
- `db-pool-exhaustion` v1;
- `false-alert` v1;
- `deployment-caused-incident-a` v1;
- `dependency-caused-incident-b` v1.

The exact five-scenario set is asserted by
`incident-lab/tests/aic16-completion.live.mjs` › "regenerates one byte-stable
replayable candidate per frozen v0.1 scenario after isolated resets".

The regeneration command resets immediately before each scenario starts and
performs a final reset. See `test/incident-lab-operator-contract.test.mjs` ›
"resets before every scenario in the five-scenario regeneration sequence".
After the final reset, every declared observation returns `409`; the complete
candidate and isolation proof is
`incident-lab/tests/aic16-completion.live.mjs` › "regenerates one byte-stable
replayable candidate per frozen v0.1 scenario after isolated resets".

Run the Docker-backed acceptance lane with:

```bash
npm run test:live-lab
```

The ordinary `npm test` and `npm run check` lanes remain Docker-independent.

## Regenerate and validate candidates

Start the lab on a chosen loopback port:

```bash
AIC_LAB_HOST_PORT=3000 docker compose \
  --file incident-lab/compose.yaml up --detach --wait
```

Then record a complete candidate set into a new directory:

```bash
npm run live-lab:regenerate -- \
  --base-url http://127.0.0.1:3000 \
  --candidate-directory ./candidate-recordings/aic-v01
```

The command resets, starts, and records each scenario through the existing
`LiveToolAdapter`. It writes one versioned JSON envelope per scenario with the
scenario ID and version, lab topology version, every tool call and input, every
live result, and an embedded `ReplayToolAdapter` fixture. Files use
exclusive-create semantics. If any target already exists, the command refuses
the set instead of overwriting it. These properties are exercised by
`incident-lab/tests/aic16-completion.live.mjs` › "regenerates one byte-stable
replayable candidate per frozen v0.1 scenario after isolated resets".

Compare a complete candidate set with the accepted v0.1 replay observations:

```bash
npm run live-lab:validate-candidates -- \
  --candidate-directory ./candidate-recordings/aic-v01
```

Validation rejects missing and extra scenarios and reports drift per scenario
and observation. It never writes to the accepted fixture source. See
`test/incident-lab-candidate-validation.test.mjs` › "rejects an incomplete
candidate set instead of validating a partial corpus", "rejects an extra
candidate instead of silently widening the accepted corpus", and "reports
replay drift against the affected scenario and observation".

Candidate promotion is deliberately separate and human-reviewed:

1. regenerate into a new candidate directory;
2. validate the complete set and inspect every JSON file and any drift report;
3. if a ground-truth change is justified, open a separate PR that explicitly
   changes `packages/evals/src/replay-scenarios.ts`;
4. run the replay benchmark and required reviews on that PR;
5. obtain human approval before merge.

The package exposes regeneration and validation, but no automatic promotion
command. See `test/incident-lab-operator-contract.test.mjs` › "exposes review
commands without an automatic promotion command". A live candidate is evidence
for review, not accepted replay ground truth.

Stop and remove the isolated lab after recording:

```bash
AIC_LAB_HOST_PORT=3000 docker compose \
  --file incident-lab/compose.yaml down --volumes --remove-orphans
```

This v0.2 lab does not add PostgreSQL, Redis, OpenTelemetry, Prometheus, Loki,
production topology, or durable run ownership. None is required to reproduce
the ten frozen observations above; those infrastructure concerns remain behind
their roadmap gates.
