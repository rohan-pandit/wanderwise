import { describe, expect, it } from "vitest";

// Proves the Vitest harness is wired up correctly (Phase 0). Delete once
// real domain-logic tests land in Phase 2 (PROJECT_BRIEF.md §16).
describe("test harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
