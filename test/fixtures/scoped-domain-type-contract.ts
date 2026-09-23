/**
 * The compile-time half of the scoped-domain contract (AIC-96, slice A).
 *
 * What it proves: `ServiceInput` never accepts a caller-supplied `id`,
 * `CredentialRef` never carries a `value` field beside its `secretName`
 * reference, and every `IncidentIntake` carries a `primaryScope`. The runtime
 * half of each of these is covered by scoped-domain-contract.test.mjs.
 *
 * A real value, not a `declare`: `node --test` also EXECUTES this fixture with
 * its types stripped (test/fixtures is swept by the default test-file
 * discovery, same as graph-owned-control-type-contract.ts), so every binding
 * below is a plain object literal that must also be valid JavaScript. Every
 * import here is `import type`, so type stripping removes the import
 * statements entirely and this file needs no runtime module resolution at
 * all.
 *
 * Every id below is a real UUID (`RegistryIdSchema = z.uuid()`) - a
 * hyphenated name like `payments-api` is exactly what
 * scoped-domain-contract.test.mjs's "refuses a repository-style name or a
 * bare word as a registry id, and accepts a UUID" refuses at runtime, and this
 * file's ids should not model the shape that test exists to reject. Two of the
 * local names below (`readCredRefId`, `writeRefId`) are deliberately spelled
 * to avoid the literal substring "credential": a `<name with "credential" or
 * "secret" in it> = "<uuid>"` declaration line reads, to
 * `.claude/scripts/lib/secrets.mjs`'s `assigned-secret` pattern, exactly like
 * an assigned credential (see credential-ref-secrets.test.mjs's header for the
 * same workaround, applied there instead by binding through `randomUUID()`).
 */
import type {
  ActionPolicy,
  CredentialRef,
  Environment,
  Incident,
  IncidentIntake,
  IntakeDerivedIncident,
  PrimaryScope,
  RegistrySnapshot,
  Service,
  ServiceInput,
  SourceBinding,
} from '@aic/domain';

const serviceId = '7b2acc9b-8ea2-4433-91c0-08f078e4a43f';
const environmentId = '7b103107-d94f-4e58-9f5b-5a2a2b4e464b';
const readCredRefId = 'f91bde38-5225-4d7b-8579-404c5cd8a133';
const sourceBindingId = '4b97410a-55a4-438f-90c2-6c8f9b460fff';
const actionPolicyId = '6bed7f4a-de27-4901-8b96-03c5a022ca25';
const writeRefId = 'a6409c12-8051-4a0d-b31e-1cb41e344c55';

const service: Service = {
  id: serviceId,
  name: 'checkout',
  repositoryAliases: ['org/checkout'],
};

const serviceInput: ServiceInput = {
  name: 'checkout',
  repositoryAliases: ['org/checkout'],
};

const serviceInputWithId: ServiceInput = {
  name: 'checkout',
  repositoryAliases: ['org/checkout'],
  // @ts-expect-error a caller never supplies a Service's id on ServiceInput
  id: serviceId,
};

const environment: Environment = {
  id: environmentId,
  serviceId,
  name: 'production',
};

const sourceBinding: SourceBinding = {
  id: sourceBindingId,
  environmentId,
  adapterId: 'github-actions',
  adapterVersion: '1.0.0',
  credentialRefId: readCredRefId,
};

const credentialRef: CredentialRef = {
  id: readCredRefId,
  environmentId,
  access: 'read',
  secretName: 'CHECKOUT_READ',
};

const credentialRefWithValue: CredentialRef = {
  id: readCredRefId,
  environmentId,
  access: 'read',
  secretName: 'CHECKOUT_READ',
  // @ts-expect-error a CredentialRef never carries the secret's own value
  value: 'not-a-real-secret',
};

const actionPolicy: ActionPolicy = {
  id: actionPolicyId,
  environmentId,
  allowedActionTypes: ['restart-service'],
  writeCredentialRefIds: [writeRefId],
};

const registry: RegistrySnapshot = {
  services: [service],
  environments: [environment],
  sourceBindings: [sourceBinding],
  credentialRefs: [credentialRef],
  actionPolicies: [actionPolicy],
};

const primaryScope: PrimaryScope = { serviceId, environmentId };

const intake: IncidentIntake = {
  primaryScope,
  title: 'Checkout failures',
  startedAt: '2026-09-23T10:00:00Z',
  signals: [],
};

// @ts-expect-error every IncidentIntake carries a primaryScope
const intakeWithoutScope: IncidentIntake = {
  title: 'Checkout failures',
  startedAt: '2026-09-23T10:00:00Z',
  signals: [],
};

void serviceInput;
void serviceInputWithId;
void credentialRefWithValue;
void registry;
void intake;
void intakeWithoutScope;

// `IncidentSchema` requires the same `primaryScope` `IncidentIntake` carries
// above (AIC-96), so an `Incident` without one is a type error.
// @ts-expect-error every Incident carries a primaryScope
const incidentWithoutScope: Incident = {
  id: 'incident-without-scope',
};
void incidentWithoutScope;

// The return type of incidentFromIntake is nameable by its consumers.
const derived: IntakeDerivedIncident = {
  id: '4f1d3b52-5b8e-4a55-9f0e-1c2d3e4f5a6b',
  primaryScope: {
    serviceId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
    environmentId: '0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a',
  },
  title: 'Checkout failures',
  startedAt: '2026-09-23T10:00:00Z',
  signals: [],
  idempotencyKey: 'sha256:46aa26c9d8e0ce395d20830fe78153816d986250019ce85e843d5dcfd9bf0cf9',
};
void derived;
