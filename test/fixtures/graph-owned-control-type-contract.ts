/**
 * The compile-time half of the graph-owned control contract.
 *
 * The runtime half — `test/graph-owned-control-contract.test.mjs` — proves the
 * graph restores a hijacked field. This file proves a node cannot even express
 * the hijack: `InvestigationNodeResult` must derive its control shape from
 * `GRAPH_OWNED_CONTROL_FIELDS`, so writing one of those fields is a type error
 * rather than a write the graph quietly undoes.
 */
import {
  INCIDENT_STATE_SCHEMA_VERSION,
  STATUS_RULES_VERSION,
} from '@aic/domain';
import {
  GRAPH_OWNED_CONTROL_FIELDS,
  type InvestigationNodeResult,
} from '@aic/graph';

// The exported constant is the single source the node-result type derives from;
// referencing it here makes a missing export fail this fixture too.
void GRAPH_OWNED_CONTROL_FIELDS;

const nodeWritableUpdate: InvestigationNodeResult = {
  control: {
    schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
    statusRulesVersion: STATUS_RULES_VERSION,
    phase: 'concluding',
  },
};

const graphOwnedUpdate: InvestigationNodeResult = {
  control: {
    schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
    statusRulesVersion: STATUS_RULES_VERSION,
    phase: 'concluding',
    // @ts-expect-error a lifecycle node may not write a graph-owned control field
    iterationsUsed: 3,
  },
};

void nodeWritableUpdate;
void graphOwnedUpdate;
