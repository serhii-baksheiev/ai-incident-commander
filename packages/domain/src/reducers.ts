type Identified = Readonly<{ id: string }>;

export function upsertById<T extends Identified>(
  current: readonly T[],
  update: T | readonly T[],
): T[] {
  const result = [...current];
  const indexById = new Map(result.map((value, index) => [value.id, index]));
  const updates: readonly T[] = Array.isArray(update) ? update : [update as T];

  for (const value of updates) {
    const index = indexById.get(value.id);

    if (index === undefined) {
      indexById.set(value.id, result.length);
      result.push(value);
    } else {
      result[index] = value;
    }
  }

  return result;
}
