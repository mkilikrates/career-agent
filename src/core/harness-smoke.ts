// Trivial framework-agnostic @core helpers used only to prove the build/test
// harness works. These are NOT domain logic (domain types arrive in task 1.2)
// and carry no dependency on React, storage, providers, or the network.

/** Integer/number addition. */
export function add(a: number, b: number): number {
  return a + b;
}

/** Returns a new array with the elements in reverse order (pure, non-mutating). */
export function reverse<T>(items: readonly T[]): T[] {
  return [...items].reverse();
}
