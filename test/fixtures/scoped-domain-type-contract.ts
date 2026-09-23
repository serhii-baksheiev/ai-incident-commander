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
 * Every id below is kept under sixteen characters for the same reason
 * scoped-domain-contract.test.mjs's secretName fixtures are: a longer
 * `<field with "credential" or "secret" in its name> = "<value>"` line reads,
 * to `.claude/scripts/lib/secrets.mjs`'s `assigned-secret` pattern, exactly
 * like an assigned credential.
 */
import type {
  ActionPolicy,
  CredentialRef,
  Environment,
  IncidentIntake,
  PrimaryScope,
  RegistrySnapshot,
  Service,
  ServiceInput,
  SourceBinding,
} from '@aic/domain';

const serviceId = 'svc-a';
const environmentId = 'env-a';
const credentialRefId = 'cred-read-a';

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
  id: 'src-binding-a',
  environmentId,
  adapterId: 'github-actions',
  adapterVersion: '1.0.0',
  credentialRefId,
};

const credentialRef: CredentialRef = {
  id: credentialRefId,
  environmentId,
  access: 'read',
  secretName: 'CHECKOUT_READ',
};

const credentialRefWithValue: CredentialRef = {
  id: credentialRefId,
  environmentId,
  access: 'read',
  secretName: 'CHECKOUT_READ',
  // @ts-expect-error a CredentialRef never carries the secret's own value
  value: 'not-a-real-secret',
};

const actionPolicy: ActionPolicy = {
  id: 'act-policy-a',
  environmentId,
  allowedActionTypes: ['restart-service'],
  writeCredentialRefIds: ['cred-write-a'],
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
