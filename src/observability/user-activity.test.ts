import { describe, expect, it } from "vitest";
import {
  buildTripSnapshot,
  buildUserTimeline,
  collectDecisionInventoryIds,
  collectInventoryIds,
  countErrors,
  describeTripEvent,
  summarizeUsers,
  tripIdForMessage,
  type TripRow,
  type UserTimelineInput,
} from "./user-activity";

const names = new Map([
  ["fl-out", "TAP TP202 · JFK→LIS"],
  ["fl-ret", "TAP TP201 · LIS→JFK"],
  ["ho-1", "Memmo Alfama"],
  ["ac-1", "Tram 28 tour"],
]);

function trip(overrides: Partial<TripRow> = {}): TripRow {
  return { id: "trip-1", name: "Lisbon", status: "collecting_requirements", session_id: "sess-1", created_at: "2026-09-20T09:00:00Z", ...overrides };
}

function emptyInput(overrides: Partial<UserTimelineInput> = {}): UserTimelineInput {
  return { trips: [trip()], messages: [], tripEvents: [], agentErrors: [], guardrailBlocks: [], feedback: [], names, ...overrides };
}

describe("describeTripEvent", () => {
  it("labels selections with inventory names", () => {
    const flight = describeTripEvent(
      { trip_id: "trip-1", event_type: "flight_step_confirmed", payload: { outboundFlightId: "fl-out", returnFlightId: "fl-ret" }, created_at: "" },
      names,
    );
    expect(flight).toEqual({ tone: "selection", title: "Selected flights", detail: "Outbound: TAP TP202 · JFK→LIS\nReturn: TAP TP201 · LIS→JFK" });

    const hotel = describeTripEvent({ trip_id: "trip-1", event_type: "hotel_step_confirmed", payload: { hotelId: "ho-1" }, created_at: "" }, names);
    expect(hotel.detail).toBe("Memmo Alfama");
  });

  it("falls back to a short id when a name wasn't resolved", () => {
    const item = describeTripEvent({ trip_id: "t", event_type: "activity_selected", payload: { activityId: "0123456789abcdef" }, created_at: "" }, names);
    expect(item.detail).toBe("01234567…");
  });

  it("counts proposed options", () => {
    const item = describeTripEvent(
      { trip_id: "t", event_type: "flight_step_proposed", payload: { candidates: [{}, {}, {}] }, created_at: "" },
      names,
    );
    expect(item).toMatchObject({ tone: "agent", title: "Shown 3 flight options" });
  });

  it("marks chain failures as errors with their message", () => {
    const item = describeTripEvent(
      { trip_id: "t", event_type: "chain_propose_failed", payload: { step: "flight", message: "No flights found" }, created_at: "" },
      names,
    );
    expect(item).toEqual({ tone: "error", title: "Couldn't load flight options", detail: "No flights found" });
  });

  it("treats transition mirrors as workflow, failed states as errors, and finalize/cancel as milestones", () => {
    const plain = describeTripEvent({ trip_id: "t", event_type: "requirements_complete", payload: { fromState: "collecting_requirements", toState: "requirements_ready" }, created_at: "" }, names);
    expect(plain).toEqual({ tone: "workflow", title: "Workflow: requirements_complete", detail: "collecting_requirements → requirements_ready" });

    const failed = describeTripEvent({ trip_id: "t", event_type: "fail", payload: { fromState: "searching_inventory", toState: "failed_recoverable" }, created_at: "" }, names);
    expect(failed.tone).toBe("error");

    const finalized = describeTripEvent({ trip_id: "t", event_type: "finalize", payload: { fromState: "awaiting_confirmation", toState: "finalized" }, created_at: "" }, names);
    expect(finalized).toMatchObject({ tone: "milestone", title: "Finalized the trip" });
  });

  it("still renders an unknown event type rather than dropping it", () => {
    expect(describeTripEvent({ trip_id: "t", event_type: "something_new", payload: {}, created_at: "" }, names)).toEqual({
      tone: "workflow",
      title: "something_new",
      detail: null,
    });
  });
});

describe("tripIdForMessage", () => {
  it("attributes a message to the latest trip created at or before it in the same session", () => {
    const trips = [trip({ id: "a", created_at: "2026-09-20T09:00:00Z" }), trip({ id: "b", created_at: "2026-09-20T10:00:00Z" })];
    const bySession = new Map([["sess-1", trips]]);
    expect(tripIdForMessage({ session_id: "sess-1", role: "user", content: "", created_at: "2026-09-20T09:30:00Z" }, bySession)).toBe("a");
    expect(tripIdForMessage({ session_id: "sess-1", role: "user", content: "", created_at: "2026-09-20T10:30:00Z" }, bySession)).toBe("b");
    expect(tripIdForMessage({ session_id: "sess-1", role: "user", content: "", created_at: "2026-09-20T08:00:00Z" }, bySession)).toBe("a");
    expect(tripIdForMessage({ session_id: "other", role: "user", content: "", created_at: "2026-09-20T08:00:00Z" }, bySession)).toBeNull();
  });
});

describe("buildUserTimeline", () => {
  it("merges every source chronologically, keeping source order on ties", () => {
    const timeline = buildUserTimeline(
      emptyInput({
        messages: [
          { session_id: "sess-1", role: "user", content: "Lisbon in May", created_at: "2026-09-20T09:01:00Z" },
          { session_id: "sess-1", role: "assistant", content: "Great choice", created_at: "2026-09-20T09:01:00Z" },
        ],
        tripEvents: [
          { trip_id: "trip-1", event_type: "trip_created", payload: {}, created_at: "2026-09-20T09:00:00Z" },
          { trip_id: "trip-1", event_type: "hotel_step_confirmed", payload: { hotelId: "ho-1" }, created_at: "2026-09-20T09:05:00Z" },
        ],
        agentErrors: [{ trip_id: "trip-1", agent_name: "intake", error_message: "timeout", created_at: "2026-09-20T09:02:00Z" }],
        guardrailBlocks: [{ trip_id: "trip-1", guardrail_name: "scope", layer: "input_scope", detail: "off-topic", created_at: "2026-09-20T09:03:00Z" }],
        feedback: [{ trip_id: null, kind: "bug", categories: ["flights"], message: "slow", created_at: "2026-09-20T09:06:00Z" }],
      }),
    );

    expect(timeline.map((i) => i.title)).toEqual([
      "Started a new trip",
      "User",
      "Agent",
      "Agent error (intake)",
      "Guardrail triggered: scope",
      "Selected hotel",
      "Sent feedback (bug)",
    ]);
    expect(timeline[1]).toMatchObject({ detail: "Lisbon in May", tripId: "trip-1" });
    expect(timeline[4].detail).toBe("input_scope — off-topic");
    expect(timeline[6]).toMatchObject({ tripId: null, detail: "[flights] slow" });
    expect(countErrors(timeline)).toBe(1);
  });
});

describe("buildUserTimeline repeat folding", () => {
  it("folds back-to-back identical events but never chat", () => {
    const proposed = (at: string) => ({ trip_id: "trip-1", event_type: "flight_step_proposed", payload: { candidates: [{}, {}] }, created_at: at });
    const timeline = buildUserTimeline(
      emptyInput({
        tripEvents: [proposed("2026-09-20T09:00:00Z"), proposed("2026-09-20T09:01:00Z"), proposed("2026-09-20T09:02:00Z")],
        messages: [
          { session_id: "sess-1", role: "user", content: "same", created_at: "2026-09-20T09:03:00Z" },
          { session_id: "sess-1", role: "user", content: "same", created_at: "2026-09-20T09:04:00Z" },
        ],
      }),
    );
    expect(timeline.map((i) => i.title)).toEqual(["Shown 2 flight options (×3)", "User", "User"]);
    expect(timeline[0].at).toBe("2026-09-20T09:00:00Z");
  });
});

describe("buildTripSnapshot", () => {
  it("shows current picks, preferring confirmed over proposed and ignoring superseded", () => {
    const decisions = [
      { field: "outboundFlight", status: "superseded", value: "old" },
      { field: "outboundFlight", status: "confirmed", value: "fl-out" },
      { field: "returnFlight", status: "confirmed", value: "fl-ret" },
      { field: "hotel", status: "proposed", value: "ho-1" },
      { field: "activity", status: "confirmed", value: "ac-1" },
      { field: "activity", status: "superseded", value: "ac-2" },
    ];
    const snapshot = buildTripSnapshot([{ field: "destination", value: "Lisbon" }, { field: "partySize", value: 2 }], decisions, names);
    expect(snapshot).toEqual({
      requirements: "Lisbon · 2 travelers",
      chainStep: "Chain step: hotel",
      outboundFlight: "TAP TP202 · JFK→LIS",
      returnFlight: "TAP TP201 · LIS→JFK",
      hotel: "Memmo Alfama",
      activities: ["Tram 28 tour"],
    });
    expect(collectDecisionInventoryIds(decisions)).toEqual({ flightIds: ["fl-out", "fl-ret"], hotelIds: ["ho-1"], activityIds: ["ac-1"] });
  });

  it("handles a trip with nothing entered yet", () => {
    expect(buildTripSnapshot([], [], names)).toEqual({
      requirements: null,
      chainStep: "Chain step: flight",
      outboundFlight: null,
      returnFlight: null,
      hotel: null,
      activities: [],
    });
  });
});

describe("collectInventoryIds", () => {
  it("finds ids in selections and proposal candidate lists", () => {
    const ids = collectInventoryIds([
      { trip_id: "t", event_type: "flight_step_proposed", payload: { candidates: [{ outboundFlightId: "a", returnFlightId: "b" }] }, created_at: "" },
      { trip_id: "t", event_type: "hotel_step_confirmed", payload: { hotelId: "h" }, created_at: "" },
      { trip_id: "t", event_type: "activities_step_confirmed", payload: { scheduledActivityIds: ["x"], unscheduledActivityIds: ["y"] }, created_at: "" },
    ]);
    expect(ids).toEqual({ flightIds: ["a", "b"], hotelIds: ["h"], activityIds: ["x", "y"] });
  });
});

describe("summarizeUsers", () => {
  it("rolls up trips, user messages, errors and last activity per user, most recent first", () => {
    const summaries = summarizeUsers(
      [
        { userId: "dan", email: "dan@example.com", createdAt: "2026-09-01T00:00:00Z", lastSignInAt: "2026-09-20T08:59:00Z" },
        { userId: "idle", email: "idle@example.com", createdAt: "2026-09-02T00:00:00Z", lastSignInAt: null },
      ],
      [
        { id: "t1", user_id: "dan", session_id: "s1", status: "finalized", created_at: "2026-09-20T09:00:00Z" },
        { id: "t2", user_id: "dan", session_id: "s2", status: "cancelled", created_at: "2026-09-21T09:00:00Z" },
      ],
      [
        { session_id: "s1", role: "user", created_at: "2026-09-20T09:01:00Z" },
        { session_id: "s1", role: "assistant", created_at: "2026-09-20T09:02:00Z" },
        { session_id: "s2", role: "user", created_at: "2026-09-21T09:05:00Z" },
      ],
      ["t2", "t2", "unknown-trip"],
    );

    expect(summaries[0]).toMatchObject({
      userId: "dan",
      tripCount: 2,
      finalizedCount: 1,
      userMessageCount: 2,
      errorCount: 2,
      lastActiveAt: "2026-09-21T09:05:00Z",
    });
    expect(summaries[1]).toMatchObject({ userId: "idle", tripCount: 0, errorCount: 0, lastActiveAt: null });
  });
});
