/**
 * Deterministic pseudo-randomness for synthetic inventory generation
 * (large-scale seed data, `src/domain/flight-generator.ts`). Every caller
 * seeds from a stable string key (a city name, a route, a route+date) so
 * re-running a generator against the same inputs always produces the same
 * output — required for the flight generator's "same route+date always
 * returns the same flights" guarantee, and handy for reproducible seed data.
 * Not cryptographic — this is content variety, not security.
 */

/** FNV-1a — fast, stable, good-enough distribution for seeding a PRNG from a string. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A seeded PRNG (mulberry32) returning floats in [0, 1). */
export type Rng = () => number;

export function seededRng(seed: number | string): Rng {
  let state = typeof seed === "string" ? hashString(seed) : seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random integer in [min, max], inclusive. */
export function randomInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Random float in [min, max). */
export function randomFloat(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Picks one element deterministically. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

/** Picks `count` distinct elements (no repeats), preserving `items`' relative order. */
export function pickMany<T>(rng: Rng, items: readonly T[], count: number): T[] {
  const pool = [...items];
  const result: T[] = [];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const index = Math.floor(rng() * pool.length);
    result.push(pool[index]);
    pool.splice(index, 1);
  }
  return result;
}

/** True with probability `p` (0-1). */
export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}
