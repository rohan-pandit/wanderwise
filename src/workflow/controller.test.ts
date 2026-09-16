import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";

vi.mock("@/src/repositories/trips");
vi.mock("@/src/repositories/trip-state");
vi.mock("@/src/repositories/trip-events");
vi.mock("@/src/repositories/workflow-runs");

import { createTrip, updateTripStatus } from "@/src/repositories/trips";
import {
  appendTripStateVersion,
  findTripStateVersionByCorrelationId,
  getLatestTripState,
  getTripStateAtVersion,
} from "@/src/repositories/trip-state";
import { appendTripEvent, findTripEventByCorrelationId } from "@/src/repositories/trip-events";
import {
  completeWorkflowRun,
  findWorkflowStepByCorrelationId,
  getOrCreateActiveWorkflowRun,
  recordWorkflowStep,
} from "@/src/repositories/workflow-runs";
import { advanceTrip, CorrelationIdReusedError, InvalidCorrelationIdError, startTrip } from "./controller";

const supabase = {} as SupabaseClient<Database>;

const TRIP_ID = "trip-1";
const CORR_1 = "11111111-1111-1111-1111-111111111111";
const CORR_2 = "22222222-2222-2222-2222-222222222222";
const RUN = { id: "run-1", trip_id: TRIP_ID, status: "running", started_at: "now", completed_at: null };

function stateAt(workflowState: string, version: number, operationType = "x") {
  return {
    version,
    state: { workflowState },
    actor: "system",
    operationType,
    correlationId: null,
    createdAt: "now",
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getOrCreateActiveWorkflowRun).mockResolvedValue(RUN as never);
  vi.mocked(findTripStateVersionByCorrelationId).mockResolvedValue(null);
  vi.mocked(findTripEventByCorrelationId).mockResolvedValue(null);
  vi.mocked(findWorkflowStepByCorrelationId).mockResolvedValue(null);
});

describe("startTrip", () => {
  it("creates the trip and writes its genesis state version and mirrors", async () => {
    const trip = { id: TRIP_ID, session_id: "s1", user_id: "u1", status: "created", created_at: "now" };
    vi.mocked(createTrip).mockResolvedValue(trip as never);
    vi.mocked(appendTripStateVersion).mockResolvedValue({ status: "applied", version: 1 });

    const result = await startTrip(supabase, { sessionId: "s1", userId: "u1" });

    expect(result).toEqual({ trip, version: 1 });
    expect(appendTripStateVersion).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ tripId: TRIP_ID, expectedVersion: 0, state: { workflowState: "created" } }),
    );
    expect(appendTripEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ tripId: TRIP_ID, eventType: "trip_created" }),
    );
    expect(recordWorkflowStep).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ fromState: null, toState: "created" }),
    );
  });
});

describe("advanceTrip", () => {
  it("rejects a correlationId that isn't a valid UUID before touching the database", async () => {
    await expect(
      advanceTrip(supabase, {
        tripId: TRIP_ID,
        event: "start_intake",
        actor: "user",
        correlationId: "not-a-uuid",
      }),
    ).rejects.toThrow(InvalidCorrelationIdError);
    expect(findTripStateVersionByCorrelationId).not.toHaveBeenCalled();
  });

  it("applies an allowed transition and writes state, event, status, and a workflow step", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("created", 1) as never);
    vi.mocked(appendTripStateVersion).mockResolvedValue({ status: "applied", version: 2 });

    const result = await advanceTrip(supabase, {
      tripId: TRIP_ID,
      event: "start_intake",
      actor: "user",
      correlationId: CORR_1,
    });

    expect(result).toEqual({
      status: "applied",
      fromState: "created",
      toState: "collecting_requirements",
      version: 2,
    });
    expect(appendTripStateVersion).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ expectedVersion: 1, state: { workflowState: "collecting_requirements" } }),
    );
    expect(updateTripStatus).toHaveBeenCalledWith(supabase, TRIP_ID, "collecting_requirements");
    expect(appendTripEvent).toHaveBeenCalledOnce();
    expect(recordWorkflowStep).toHaveBeenCalledOnce();
    expect(completeWorkflowRun).not.toHaveBeenCalled();
  });

  it("rejects a disallowed transition without writing anything", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("created", 1) as never);

    const result = await advanceTrip(supabase, {
      tripId: TRIP_ID,
      event: "user_confirmed",
      actor: "user",
      correlationId: CORR_1,
    });

    expect(result.status).toBe("rejected");
    expect(appendTripStateVersion).not.toHaveBeenCalled();
    expect(appendTripEvent).not.toHaveBeenCalled();
  });

  it("reports a conflict and skips mirror writes when the version append loses a race", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("created", 1) as never);
    vi.mocked(appendTripStateVersion).mockResolvedValue({ status: "conflict" });

    const result = await advanceTrip(supabase, {
      tripId: TRIP_ID,
      event: "start_intake",
      actor: "user",
      correlationId: CORR_1,
    });

    expect(result).toEqual({ status: "conflict" });
    expect(appendTripEvent).not.toHaveBeenCalled();
    expect(updateTripStatus).not.toHaveBeenCalled();
    expect(recordWorkflowStep).not.toHaveBeenCalled();
  });

  it("completes the workflow run when the transition reaches a terminal state", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("awaiting_confirmation", 5) as never);
    vi.mocked(appendTripStateVersion).mockResolvedValue({ status: "applied", version: 6 });

    const result = await advanceTrip(supabase, {
      tripId: TRIP_ID,
      event: "user_confirmed",
      actor: "user",
      correlationId: CORR_2,
      proposalHashMatches: true,
      guardrailsPassed: true,
    });

    expect(result).toEqual({
      status: "applied",
      fromState: "awaiting_confirmation",
      toState: "finalized",
      version: 6,
    });
    expect(completeWorkflowRun).toHaveBeenCalledWith(supabase, RUN.id, "finalized");
  });

  it("throws if the trip has no state history yet", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(null);

    await expect(
      advanceTrip(supabase, {
        tripId: TRIP_ID,
        event: "start_intake",
        actor: "user",
        correlationId: CORR_1,
      }),
    ).rejects.toThrow("no state history");
  });

  describe("replaying a correlationId already applied", () => {
    beforeEach(() => {
      // A prior call already appended version 2 (created -> collecting_requirements)
      // under CORR_1, but (per the scenario under test) some mirror writes may not
      // have completed before that call failed.
      vi.mocked(findTripStateVersionByCorrelationId).mockResolvedValue(
        stateAt("collecting_requirements", 2, "start_intake") as never,
      );
      vi.mocked(getLatestTripState).mockResolvedValue(stateAt("collecting_requirements", 2) as never);
      vi.mocked(getTripStateAtVersion).mockResolvedValue(stateAt("created", 1) as never);
    });

    it("returns the original transition's result without reapplying the state version", async () => {
      const result = await advanceTrip(supabase, {
        tripId: TRIP_ID,
        event: "start_intake",
        actor: "user",
        correlationId: CORR_1,
      });

      expect(result).toEqual({
        status: "replayed",
        fromState: "created",
        toState: "collecting_requirements",
        version: 2,
      });
      expect(appendTripStateVersion).not.toHaveBeenCalled();
    });

    it("finishes a trip_events write that didn't complete on the original attempt", async () => {
      vi.mocked(findTripEventByCorrelationId).mockResolvedValue(null);

      await advanceTrip(supabase, {
        tripId: TRIP_ID,
        event: "start_intake",
        actor: "user",
        correlationId: CORR_1,
      });

      expect(appendTripEvent).toHaveBeenCalledOnce();
      expect(updateTripStatus).toHaveBeenCalledWith(supabase, TRIP_ID, "collecting_requirements");
    });

    it("doesn't double-write a trip_events row that already exists", async () => {
      vi.mocked(findTripEventByCorrelationId).mockResolvedValue({ id: "evt-1" } as never);

      await advanceTrip(supabase, {
        tripId: TRIP_ID,
        event: "start_intake",
        actor: "user",
        correlationId: CORR_1,
      });

      expect(appendTripEvent).not.toHaveBeenCalled();
    });

    it("doesn't double-write a workflow_steps row that already exists", async () => {
      vi.mocked(findWorkflowStepByCorrelationId).mockResolvedValue({ id: "step-1" } as never);

      await advanceTrip(supabase, {
        tripId: TRIP_ID,
        event: "start_intake",
        actor: "user",
        correlationId: CORR_1,
      });

      expect(recordWorkflowStep).not.toHaveBeenCalled();
    });

    it("throws if the correlationId was already used for a different event", async () => {
      vi.mocked(findTripStateVersionByCorrelationId).mockResolvedValue(
        stateAt("collecting_requirements", 2, "start_intake") as never,
      );

      await expect(
        advanceTrip(supabase, {
          tripId: TRIP_ID,
          event: "requirements_complete", // different from the recorded "start_intake"
          actor: "user",
          correlationId: CORR_1,
        }),
      ).rejects.toThrow(CorrelationIdReusedError);
    });
  });
});
