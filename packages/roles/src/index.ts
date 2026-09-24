import { DOMAIN_LAYER } from '@aic/domain';
import { GRAPH_DEPENDENCIES } from '@aic/graph';

export * from './model-config.js';
export * from './model-errors.js';
export * from './model-usage-ledger.js';
export * from './investigation-roles.js';
export * from './naive-role.js';

export {
  MODEL_API_KEY_VARIABLE,
  MODEL_ID_VARIABLE,
  REFERENCE_MODEL_ID,
  REFERENCE_MODEL_PROVIDER,
  createReferenceModelPort,
  type FetchImpl,
  type ModelCompletion,
  type ModelCompletionRequest,
  type ModelPort,
} from './reference-model-port.js';

export const ROLE_LAYER = 'roles' as const;
export const ROLE_DEPENDENCIES = [DOMAIN_LAYER, ...GRAPH_DEPENDENCIES] as const;
