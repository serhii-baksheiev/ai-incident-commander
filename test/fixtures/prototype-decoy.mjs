/**
 * Prototype-pollution decoys, in one implementation.
 *
 * Two test files now plant properties on `Object.prototype` to prove that a
 * metric path reads and writes what a run OWNS:
 * `test/benchmark-resource-evidence.test.mjs` and
 * `test/metric-path-prototype-safety.test.mjs`. A second hand-written copy of
 * the planting-and-removal dance would be a second thing to keep correct, and
 * the copy nobody is looking at is the one that leaks a planted property into
 * the rest of the suite — `.claude/rules/invariants.md` ("One mechanism, one
 * implementation").
 *
 * This module is discovered by `node --test` alongside the suite's test files —
 * `node --test --test-reporter=spec` lists it — so it is also executed in a
 * process of its own. It therefore declares no tests, does no work at import
 * time, and touches `Object.prototype` only inside a call.
 */

/**
 * Plants one own property on `Object.prototype` for the duration of `body`, and
 * takes it off again whatever happens. The planted property is what an evidence
 * object that never declared the field appears to carry to anything that reads
 * it through the prototype chain.
 *
 * The DESCRIPTOR is the caller's choice because the two shapes fail in opposite
 * directions, and only one of them is visible on the reading side.
 */
export async function withPrototypeDecoy(key, descriptor, body) {
  Object.defineProperty(Object.prototype, key, {
    configurable: true,
    enumerable: false,
    ...descriptor,
  });
  try {
    return await body();
  } finally {
    delete Object.prototype[key];
  }
}

/**
 * A data decoy: the shape that answers a prototype-chain READ with a value the
 * evidence never declared.
 */
export async function withPollutedObjectPrototype(key, value, body) {
  return withPrototypeDecoy(key, { value, writable: true }, body);
}

/**
 * An accessor decoy: the shape that also corrupts a prototype-chain WRITE.
 *
 * A writable inherited data property is shadowed by an ordinary
 * `target[key] = value` — the assignment creates an own property and the decoy
 * is overwritten, which is why the data decoy above proves nothing about the
 * write side. An accessor is not shadowed: `[[Set]]` walks the prototype chain,
 * finds the inherited setter, calls it, and creates NO own property. The key
 * then disappears from the object that was written, and the next read of it
 * returns the inherited getter's value.
 *
 * Every value the swallowing setter receives is pushed to `swallowed`, so a
 * failing assertion can report that the write really did reach the prototype
 * rather than never happening at all.
 */
export async function withAccessorPollutedObjectPrototype(key, value, swallowed, body) {
  return withPrototypeDecoy(
    key,
    {
      get() {
        return value;
      },
      set(written) {
        swallowed.push(written);
      },
    },
    body,
  );
}
