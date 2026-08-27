import { DOMAIN_LAYER } from '@aic/domain';
import { GRAPH_DEPENDENCIES } from '@aic/graph';

export const EVAL_DEPENDENCIES = [DOMAIN_LAYER, ...GRAPH_DEPENDENCIES] as const;
