import type {
  Evidence,
  InvestigationTest,
  Prediction,
  ToolId,
} from '@aic/domain';

export type ToolRisk = 'read' | 'safe-write' | 'dangerous';

export type ToolResult<Output> =
  | { status: 'ok'; output: Output }
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; message: string };

export interface IncidentTool<Input = unknown, Output = Evidence[]> {
  readonly id: ToolId;
  readonly risk: ToolRisk;
  execute(input: Input): Promise<ToolResult<Output>>;
}

export interface ReadOnlyToolDescriptor {
  readonly id: ToolId;
  readonly risk: 'read';
}

const READ_ONLY_TOOL_DESCRIPTORS = [
  { id: 'deployments', risk: 'read' },
  { id: 'logs', risk: 'read' },
  { id: 'metrics', risk: 'read' },
  { id: 'traces', risk: 'read' },
  { id: 'git', risk: 'read' },
  { id: 'dependencies', risk: 'read' },
] satisfies ReadOnlyToolDescriptor[];

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
