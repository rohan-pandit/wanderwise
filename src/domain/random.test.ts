import { describe, expect, it } from "vitest";
import { chance, hashString, pick, pickMany, randomFloat, randomInt, seededRng } from "./random";

describe("random", () => {
  it("hashString is a pure function of its input", () => {
    expect(hashString("Lisbon")).toBe(hashString("Lisbon"));
    expect(hashString("Lisbon")).not.toBe(hashString("Kyoto"));
  });

  it("seededRng produces the same sequence for the same seed", () => {
    const a = seededRng("route:NYC->Lisbon");
    const b = seededRng("route:NYC->Lisbon");
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("seededRng produces a different sequence for a different seed", () => {
    const a = seededRng("route:NYC->Lisbon")();
    const b = seededRng("route:NYC->Tokyo")();
    expect(a).not.toBe(b);
  });

  it("seededRng accepts a numeric seed too", () => {
    expect(seededRng(42)()).toBe(seededRng(42)());
  });

  it("randomInt stays within [min, max] inclusive", () => {
    const rng = seededRng("bounds");
    for (let i = 0; i < 200; i++) {
      const n = randomInt(rng, 3, 7);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(7);
    }
  });

  it("randomFloat stays within [min, max)", () => {
    const rng = seededRng("float-bounds");
    for (let i = 0; i < 200; i++) {
      const n = randomFloat(rng, 10, 20);
      expect(n).toBeGreaterThanOrEqual(10);
      expect(n).toBeLessThan(20);
    }
  });

  it("pick always returns an element from the array", () => {
    const rng = seededRng("pick");
    const items = ["a", "b", "c"];
    for (let i = 0; i < 50; i++) {
      expect(items).toContain(pick(rng, items));
    }
  });

  it("pickMany returns distinct elements, capped at the array length", () => {
    const rng = seededRng("pick-many");
    const items = [1, 2, 3, 4, 5];
    const result = pickMany(rng, items, 3);
    expect(result).toHaveLength(3);
    expect(new Set(result).size).toBe(3);
    expect(pickMany(rng, items, 10)).toHaveLength(5);
  });

  it("chance respects extreme probabilities", () => {
    const rng = seededRng("chance");
    expect(chance(rng, 0)).toBe(false);
    expect(chance(rng, 1)).toBe(true);
  });
});
