import { describe, expect, it, vi } from "vitest";
import { trackAction, type ActionTelemetryDeps } from "./action-telemetry";
import { MAX_EVENT_MESSAGE_LENGTH, normalizeEmail } from "@/src/repositories/app-events";

function deps(overrides: Partial<ActionTelemetryDeps> = {}) {
  return {
    record: vi.fn(async () => {}),
    currentUser: vi.fn(async () => ({ id: "user-1", email: "dan@example.com" })),
    ...overrides,
  };
}

describe("trackAction", () => {
  it("passes a successful result through without looking up the user or recording anything", async () => {
    const d = deps();
    await expect(trackAction("confirmHotelCandidate", "trip-1", async () => ({ ok: true }), d)).resolves.toEqual({ ok: true });
    expect(d.record).not.toHaveBeenCalled();
    expect(d.currentUser).not.toHaveBeenCalled();
  });

  it("records a returned { error } and still returns it unchanged", async () => {
    const d = deps();
    const result = await trackAction("proposeFlightCandidates", "trip-1", async () => ({ error: "No flights found" }), d);
    expect(result).toEqual({ error: "No flights found" });
    expect(d.record).toHaveBeenCalledWith({
      eventType: "action_failed",
      userId: "user-1",
      email: "dan@example.com",
      tripId: "trip-1",
      payload: { action: "proposeFlightCandidates", kind: "returned", message: "No flights found" },
    });
  });

  it("records a thrown error and rethrows the same error", async () => {
    const d = deps();
    const boom = new Error("Trip x not found.");
    await expect(trackAction("sendMessage", "trip-1", async () => { throw boom; }, d)).rejects.toBe(boom);
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({ payload: { action: "sendMessage", kind: "thrown", message: "Trip x not found." } }));
  });

  it("ignores Next's redirect/notFound control-flow errors", async () => {
    const d = deps();
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/app;307;" });
    await expect(trackAction("x", null, async () => { throw redirect; }, d)).rejects.toBe(redirect);
    expect(d.record).not.toHaveBeenCalled();
  });

  it("still surfaces the action's outcome when telemetry itself fails", async () => {
    const d = deps({ record: vi.fn(async () => { throw new Error("db down"); }), currentUser: vi.fn(async () => { throw new Error("no session"); }) });
    await expect(trackAction("x", null, async () => ({ error: "friendly" }), d)).resolves.toEqual({ error: "friendly" });
    const boom = new Error("original");
    await expect(trackAction("x", null, async () => { throw boom; }, d)).rejects.toBe(boom);
  });

  it("records a null user when nobody is signed in, and truncates long messages", async () => {
    const record = vi.fn<(event: unknown) => Promise<void>>(async () => {});
    const d = deps({ record, currentUser: vi.fn(async () => null) });
    await trackAction("x", null, async () => ({ error: "e".repeat(MAX_EVENT_MESSAGE_LENGTH + 50) }), d);
    const event = record.mock.calls[0][0] as { userId: string | null; payload: { message: string } };
    expect(event.userId).toBeNull();
    expect(event.payload.message).toHaveLength(MAX_EVENT_MESSAGE_LENGTH + 1);
  });
});

describe("normalizeEmail", () => {
  it("lower-cases and trims plausible emails, rejects everything else", () => {
    expect(normalizeEmail("  Dan@Gmail.COM ")).toBe("dan@gmail.com");
    expect(normalizeEmail("not an email")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
    expect(normalizeEmail(`${"a".repeat(250)}@b.co`)).toBeNull();
  });
});
