# Integration boundary — AIC as a standalone service, scoped by Service × Environment

- **Status:** Accepted, 2026-09-23 (AIC-97). The decisions below were accepted by
  the owner on 2026-09-04 in the triage of the v0.3 Integration Boundary epic
  (AIC-95); this record makes them the reference the implementation tickets are
  built against.
- **Scope:** v0.3. What changes at v1.0 is named where it applies.
- **Built against by:** AIC-96 (scoped domain types), AIC-100 (source adapter
  contract), AIC-98 (read-only adapters), AIC-99 (onboarding CLI), AIC-101
  (onboarding gate), AIC-21 and AIC-25 (Safe Operations), AIC-43 (domain API),
  AIC-46 (secret handling), AIC-59 (artifact provenance).

## Context

Up to v0.2, AIC investigates incidents whose evidence comes from replay fixtures
or from tools a caller assembles and injects for one run. Nothing says which
system an incident is about, which credentials a source may use, or what an
operator has to install to connect AIC to their service. v0.3 introduces
operational actions (AIC-20), and an action needs a target that is registered,
scoped and policed before it can be proposed, approved or executed.

So the question this record answers is: **how does AIC connect to the system it
investigates, and what owns what at that connection?**

## Decisions

1. **AIC is a standalone service.** It runs as its own process with its own
   storage, next to the systems it investigates, never inside them.
2. **The registered operational unit is Service × Environment.** A Service is a
   thing an operator runs; an Environment is one deployment of it (for example
   `production`, `staging`). Everything scope-bound — source bindings,
   credentials, action policy, incidents — hangs off one Environment of one
   Service.
3. **An Incident has exactly one `primaryScope { serviceId, environmentId }` in
   v0.3.** It is required on every new incident. An incident spanning several
   services is out of scope (decision 10).
4. **A repository is an alias or a source of evidence, not identity.** A Service
   may list repository aliases, and a repository may be bound as a source, but
   renaming or moving a repository never changes which Service an incident
   belongs to.
5. **AIC storage is the source of truth; YAML is an idempotent import.** A
   declarative file can be applied to create or update registrations, and
   applying the same file twice changes nothing. The registry lives in AIC's
   database, not in the file, and drift between the two is reported (AIC-99,
   acceptance 2) rather than silently resolved in the file's favour.
6. **Nothing mandatory is installed in the consumer repository** — no file, no
   agent, no runtime, no CI step. Onboarding a service leaves its repository
   byte-identical, which is what the AIC-101 gate has to prove.
7. **Embedded mode is rejected.** AIC is not shipped as a library or sidecar that
   runs inside the investigated service.
8. **A stateless connector is deferred** until one of the triggers in
   "Connector triggers" is met by a real source; until then every source is
   reached directly from AIC.
9. **Workspace stays an implicit singleton until v1.0.** There is one set of
   Services per AIC installation; multi-tenancy is a v1.0 concern.
10. **Out of scope for v0.3:** a SaaS control plane, an onboarding UI, automated
    source discovery, and multi-service incidents.

## Ownership

| Object | Owned by | Notes |
| --- | --- | --- |
| Service | the AIC installation (implicit workspace, decision 9) | identity is server-assigned; repository names are aliases (decision 4) |
| Environment | exactly one Service | an Environment never moves between Services |
| SourceBinding | exactly one Environment | a binding to a source of evidence, versioned by adapter |
| CredentialRef | exactly one Environment | a first-class record holding a reference to a secret, never the secret; a SourceBinding refers to one read `CredentialRef`, the `ActionPolicy` refers to the write `CredentialRef`s, and a `ProposedAction` only refers to one — nothing but the Environment owns it |
| ActionPolicy | exactly one Environment | which action types are allowed there |
| Incident | its `primaryScope` Environment | intake carries `idempotencyKey` (AIC-96 defines the schema, AIC-99 is the CLI that writes it) so repeated intake does not create a second Incident |
| Evidence | the run that collected it | carries its provenance as a snapshot taken at fetch time (see Trust boundary), not as a live pointer |

The consumer's service, repository and infrastructure remain owned by the
consumer; AIC owns only its own records about them.

## Trust boundary

- **Credentials cross the boundary as references.** A `CredentialRef` names a
  secret held by AIC's secret backend; its value must never enter incident
  state, Evidence, checkpoints, artifacts or traces, and secret material is
  redacted before any of those are persisted (AIC-46 owns the production backend
  and lifecycle).
- **Read and write are separate credentials.** A read binding's credential must
  never be able to execute an action; a `SAFE_WRITE` action requires a write
  `CredentialRef` distinct from every read-binding credential, referenced by an
  `ActionPolicy` that allows the action type (AIC-25). One `CredentialRef` is
  never both.
- **A source that cannot be reached, or refuses the credential, yields no
  negative evidence.** Unavailable, denied and timed-out outcomes are
  "untestable", never a finding about the service (AIC-100).
- **Everything a source returns is untrusted input** to AIC: it is parsed,
  bounded and redacted at the adapter boundary before it becomes Evidence.
- **Every piece of Evidence must record where it came from:** `sourceBindingId`,
  `adapterId@version`, `credentialRefId`, `fetchedAt` and `requestFingerprint`
  (AIC-100, AIC-59).

## Removal semantics

Removing an Environment, or a Service with all its Environments, deletes what
lets AIC act on it — its SourceBindings, its ActionPolicy and its
CredentialRefs — from the active registry (AIC-99, acceptance 5). Nothing can
then select, check or use them. What becomes of the secret a removed
CredentialRef named — revoking it in the secret backend — is part of the
credential lifecycle AIC-46 owns, and this record does not decide it.

What audits the past is kept: incidents, runs, Evidence and action history,
under the audit rules AIC-99 preserves and AIC-46 hardens. Deleting them would
erase the provenance of past decisions. Evidence stays readable after removal
because its provenance is a snapshot of identifiers and adapter version taken
at fetch time, not a pointer into the rows that were removed.

After removal, no binding, policy or credential reference for that Environment
remains active, and the consumer's repository is unchanged, as it was never
written to (decision 6).

## Connector triggers

A connector is a component deployed inside the consumer's perimeter that relays
requests from AIC to a source. It is introduced only when a real source meets
one of these triggers:

1. the source is network-inaccessible from where AIC runs;
2. the source is push-only and cannot be queried;
3. policy forbids the source's credentials from leaving its perimeter.

When one is introduced it is **stateless**: it forwards requests and responses
and holds no investigation state and no evidence. A connector that stored run
state or evidence would make it a second orchestrator, and would violate the
single-orchestrator boundary — the graph controls the investigation, and AIC's
storage is the one place its state and evidence live.

## Terminology

`packages/domain` defines the registry types as of AIC-96 — `Service`,
`Environment`, `SourceBinding`, `CredentialRef`, `ActionPolicy`,
`primaryScope`, the intake and `idempotencyKey`. The source-adapter contract
(AIC-100), the onboarding CLI (AIC-99) and the domain API (AIC-43) must use
the same names, exactly as written here:

| Term | Meaning |
| --- | --- |
| `Service` | a system an operator runs and registers with AIC |
| `Environment` | one deployment of a `Service` |
| `SourceBinding` | a versioned binding of one evidence source to one `Environment` |
| `CredentialRef` | a reference to a secret held by AIC's secret backend |
| `ActionPolicy` | the action types allowed in one `Environment` |
| `primaryScope` | `{ serviceId, environmentId }` on an Incident |
| `idempotencyKey` | the intake key that makes repeated intake of one incident a no-op |

The planned onboarding commands (AIC-99) use the same nouns:
`aic service add`, `aic env add`, `aic source add`, `aic source check`,
`aic policy set`, `aic incident start`, plus `aic doctor` and `aic apply -f`.
The existing `aic start` persistence spike, and `aic resume` beside it, are not
among them; AIC-99's scope moves both behind an explicit development-only
command.

## Consequences

- AIC-96 adds the scoped domain types and the explicit v0.2 → v0.3 state and
  schema version transition its scope names; AIC-21 and AIC-25 read `ActionPolicy` and `primaryScope` from them
  rather than from a global allow-list.
- Every evidence source goes through the adapter contract of AIC-100; tools
  assembled by a caller for one run are replaced, while deterministic replay is
  preserved.
- The AIC-101 gate has to prove onboarding end to end, including zero residue in
  the consumer repository.
- A future connector, SaaS control plane or multi-tenant workspace each needs a
  new decision record; none is implied by this one.
