# Incident Lab

The Incident Lab is the isolated live-system surface for controlled
investigation. Unit and replay gates do not require it to be running.

## Implemented slice

The `bad-deployment` v1 slice runs one containerized checkout service. Its
control API resets and starts the incident; its read-only observation API
serves the accepted scenario's `deployments` and `logs` calls. The recorder
executes those calls through the existing `LiveToolAdapter`, writes a versioned
candidate with lab provenance, and proves that its embedded fixture can be
consumed by `ReplayToolAdapter` after the live observations finish.

Run the explicit Docker-backed lane with:

```bash
npm run test:live-lab
```

Executable proof: `incident-lab/tests/bad-deployment.live.mjs` › "records a
reviewable bad-deployment candidate that replays after isolated resets".

The test creates a unique Compose project, assigns an available host port,
resets the scenario before each recording, and removes its containers and
volumes afterward. A repeated reset/start/record cycle must produce identical
candidate JSON.

Candidate files are written with exclusive-create semantics and never target
the accepted fixtures in `packages/evals/src/replay-scenarios.ts`. If the
candidate path already exists, recording stops instead of overwriting it. A
candidate is live evidence for review; it is not accepted replay ground truth
until a separate reviewed change promotes it.

This first slice deliberately does not add Postgres, Redis, observability
services, production topology, or durable run ownership. Those components are
not needed to reproduce this scenario's two observations.
