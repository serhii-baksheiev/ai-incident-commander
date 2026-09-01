# Incident Lab

The Incident Lab is an isolated live-system surface for controlled
investigation. Unit and replay gates do not require Docker or a running lab.

## v0.1 scenario lab

The version 2 lab topology contains `api`, `payments`, and `inventory` services.
Only the unauthenticated control and observation API is published to the host,
and Compose binds it to `127.0.0.1`. The other services are reachable only on
the private Compose network.

The lab reproduces the observations for all five frozen v0.1 scenarios:

- `bad-deployment` v1;
- `db-pool-exhaustion` v1;
- `false-alert` v1;
- `deployment-caused-incident-a` v1;
- `dependency-caused-incident-b` v1.

Every scenario is reset before it starts. After a reset, all observation
endpoints return `409` until another scenario is explicitly started. The
observation surface is read-only; reset and start are the only control calls.

Run the Docker-backed acceptance lane with:

```bash
npm run test:live-lab
```

The ordinary `npm test` and `npm run check` lanes remain Docker-independent.

## Regenerate and validate candidates

With the Compose lab running on a loopback port, record a complete candidate
set into a new directory:

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
the set instead of overwriting it.

Compare a complete candidate set with the accepted v0.1 replay observations:

```bash
npm run live-lab:validate-candidates -- \
  --candidate-directory ./candidate-recordings/aic-v01
```

Validation rejects missing and extra scenarios and reports drift per scenario
and observation. It never writes to the accepted fixture source.

Candidate promotion is deliberately separate and human-reviewed:

1. regenerate into a new candidate directory;
2. validate the complete set and inspect every JSON file and any drift report;
3. if a ground-truth change is justified, open a separate PR that explicitly
   changes `packages/evals/src/replay-scenarios.ts`;
4. run the replay benchmark and required reviews on that PR;
5. obtain human approval before merge.

There is no automatic promotion command. A live candidate is evidence for
review, not accepted replay ground truth.

This v0.2 lab does not add PostgreSQL, Redis, OpenTelemetry, Prometheus, Loki,
production topology, or durable run ownership. None is required to reproduce
the ten frozen observations above; those infrastructure concerns remain behind
their roadmap gates.
