type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

export const REPLAY_FIXTURE_VERSION = 1 as const;

function canonicalize(value: unknown, ancestors: Set<object>): CanonicalJson {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('tool input numbers must be finite');
    }
    return value;
  }

  if (typeof value !== 'object') {
    throw new TypeError('tool input must contain only JSON values');
  }

  if (ancestors.has(value)) {
    throw new TypeError('tool input must not contain circular references');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const canonical: CanonicalJson[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError('tool input arrays must not contain sparse holes');
        }
        canonical.push(canonicalize(value[index], ancestors));
      }
      return canonical;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('tool input objects must be plain JSON objects');
    }

    const source = value as Record<string, unknown>;
    const canonical = Object.create(null) as Record<string, CanonicalJson>;
    for (const key of Object.keys(source).sort()) {
      canonical[key] = canonicalize(source[key], ancestors);
    }
    return canonical;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalSerializeToolInput(input: unknown): string {
  return JSON.stringify(canonicalize(input, new Set()));
}

export function createReplayFixtureKey(toolId: string, input: unknown): string {
  return `${REPLAY_FIXTURE_VERSION}:${JSON.stringify([
    toolId,
    canonicalSerializeToolInput(input),
  ])}`;
}
