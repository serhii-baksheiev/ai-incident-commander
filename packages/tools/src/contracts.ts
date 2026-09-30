import { RISK_REGISTRY } from '@aic/domain';
import type {
  Evidence,
  InvestigationTest,
  Prediction,
  RiskClass,
  ToolId,
} from '@aic/domain';

// One spelling of the risk vocabulary (AIC-21 slice 1): `ToolRisk` is exactly
// `@aic/domain`'s `RiskClass`, not a second, independently maintained union —
// see test/fixtures/risk-registry-type-contract.ts.
export type ToolRisk = RiskClass;

export type ToolResult<Output> =
  | { status: 'ok'; output: Output }
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; message: string };

/** Guards an unwrapped value against ToolResult's exact variants, not just duck-typed status. */
export function isToolResult<Output>(value: unknown): value is ToolResult<Output> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.status === 'ok') {
    return Object.prototype.hasOwnProperty.call(record, 'output');
  }
  if (record.status === 'unavailable') {
    return typeof record.reason === 'string';
  }
  if (record.status === 'error') {
    return typeof record.message === 'string';
  }
  return false;
}

export interface IncidentTool<Input = unknown, Output = Evidence[]> {
  readonly id: ToolId;
  readonly risk: ToolRisk;
  execute(input: Input): Promise<ToolResult<Output>>;
}

export interface ReadOnlyToolDescriptor {
  readonly id: ToolId;
  readonly risk: 'read';
}

// Derived from `@aic/domain`'s `RISK_REGISTRY` (AIC-21 slice 1), in the
// registry's own order, rather than a private literal list — see
// test/risk-registry.test.mjs › "READ_ONLY_TOOL_REGISTRY ids are exactly the
// registry's tool-kind ids, and vice versa".
const READ_ONLY_TOOL_DESCRIPTORS = RISK_REGISTRY.entries
  .filter((entry) => entry.kind === 'tool')
  .map((entry) => ({ id: entry.id, risk: entry.risk })) satisfies ReadOnlyToolDescriptor[];

export const READ_ONLY_TOOL_REGISTRY: readonly Readonly<ReadOnlyToolDescriptor>[] =
  Object.freeze(
    READ_ONLY_TOOL_DESCRIPTORS.map((descriptor) => Object.freeze(descriptor)),
  );

const READ_ONLY_TOOL_IDS = new Set(
  READ_ONLY_TOOL_REGISTRY.map((descriptor) => descriptor.id),
);

export function isReadOnlyToolId(toolId: string): boolean {
  return READ_ONLY_TOOL_IDS.has(toolId);
}

export interface ToolResultProjectionInput {
  readonly test: InvestigationTest;
  readonly prediction: Prediction;
  readonly result: ToolResult<Evidence[]>;
}

export interface ToolResultProjection {
  readonly test: InvestigationTest;
  readonly prediction: Prediction;
  readonly evidence: Evidence[];
}

export function projectToolResult({
  test,
  prediction,
  result,
}: ToolResultProjectionInput): ToolResultProjection {
  if (result.status === 'ok') {
    return {
      test: { ...test, status: 'executed' },
      prediction,
      evidence: result.output,
    };
  }

  if (result.status === 'unavailable') {
    return {
      test: { ...test, status: 'unavailable' },
      prediction: { ...prediction, status: 'untestable' },
      evidence: [],
    };
  }

  return {
    test: { ...test, status: 'failed' },
    prediction,
    evidence: [],
  };
}
