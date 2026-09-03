/**
 * The compile-time half of the graph-owned control contract.
 *
 * What it proves: a lifecycle node cannot write a graph-owned control field in
 * the object literal it hands back. `InvestigationNodeResult` derives its
 * control shape from `GRAPH_OWNED_CONTROL_FIELDS` through `Omit`, and TypeScript
 * refuses an excess property in a FRESH object literal, so the realistic
 * authoring mistake is a type error rather than a write the graph quietly
 * undoes.
 *
 * ⚠ Its limit, stated because a reader would otherwise infer cover that is not
 * there: excess-property checking applies to the literal only. A node that
 * builds the control under a name first, mutates a copy, or hands back the
 * whole `state.control` it was given, compiles clean — the last three
 * declarations below are exactly those shapes, and this fixture asserts they
 * still compile. That is the runtime half's job, and the runtime half does it:
 * graph-owned-control-contract.test.mjs › "hides a hijacked graph-owned field
 * from every node that runs after it".
 */
import {
  INCIDENT_STATE_SCHEMA_VERSION,
  STATUS_RULES_VERSION,
  type IncidentStateControl,
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

// A real value, not a `declare`: `node --test` also EXECUTES this fixture with
// its types stripped, and a declared-only binding would be gone by then.
const handedControl: IncidentStateControl = {
  runId: 'run-type-contract',
  schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
  statusRulesVersion: STATUS_RULES_VERSION,
  phase: 'normalizing',
  maxIterations: 4,
  llmCallBudget: 8,
  reservedChallengeBudget: 2,
  challengeRounds: 0,
  iterationsUsed: 0,
  llmCallsUsed: 0,
  resumeCount: 0,
  humanReview: false,
};

// Limit 1, asserted rather than described: the same hijack behind a name is not
// a fresh literal, so nothing refuses it. If TypeScript ever did, this file
// stops compiling and the limit above stops being true — which is the signal.
const aliased = { ...handedControl, iterationsUsed: 3 };
const aliasedUpdate: InvestigationNodeResult = { control: aliased };

// Limit 2: mutating a copy after the fact.
const mutatedCopy = { ...handedControl };
mutatedCopy.iterationsUsed = 3;
const mutatedUpdate: InvestigationNodeResult = { control: mutatedCopy };

// Limit 3: handing back the whole control the node was given, all ten
// graph-owned fields included.
const passthroughUpdate: InvestigationNodeResult = {
  control: { ...handedControl },
};

void nodeWritableUpdate;
void graphOwnedUpdate;
void aliasedUpdate;
void mutatedUpdate;
void passthroughUpdate;
