/**
 * Adversarial eval cases (PROJECT_BRIEF.md §9.6's adversarial suite),
 * using the same real end-to-end harness as `evals/cases/scenarios.ts` —
 * see that file's docstring for why this needs a real Supabase trip rather
 * than a mocked one. Kept as a separate case list (matching this project's
 * one-file-per-concern pattern: `evals/cases/intake.ts`, `evals/cases/retrieval.ts`)
 * even though `evals/runners/run-scenario-eval.ts` runs both lists together
 * — they share the exact same harness/runner/persistence, so a second
 * near-duplicate runner would just be drift risk for no benefit.
 *
 * §9.6 lists eight adversarial categories. Four are covered here:
 * fabricated inventory IDs, budget-exceeding wording, contradictory user
 * messages, cross-session references. "Attempts to trigger booking" is
 * already covered by `scenarios.ts`'s `out_of_scope_request` (it doubles as
 * a prompt-injection case). Not yet covered — deliberately, not an
 * oversight: prompt injection *in retrieved activity/inventory text* and
 * malformed/malicious inventory text need a seeded adversarial fixture
 * record (temporarily mutating the shared `activities`/`destinations`
 * tables, or a dedicated fixture migration) rather than just adversarial
 * user input, which is a bigger, separate piece of work; "invalid dates and
 * currencies" beyond the contradiction case here would mostly re-test Zod
 * schema validation already covered by unit tests, not something only an
 * end-to-end eval can catch.
 */
import { randomUUID } from "node:crypto";
import { InvalidFlightSelectionError, confirmFlightStep } from "../../src/workflow/flight-step";
import { FlightStepNotConfirmedError, InvalidHotelSelectionError, confirmHotelStep } from "../../src/workflow/hotel-step";
import { SessionTripMismatchError, processIntakeTurn } from "../../src/workflow/intake-orchestrator";
import { AnthropicModelClient } from "../../src/agents/providers/anthropic-model-client";
import { AGENT_MODELS } from "../../src/config/models";
import type { ScenarioHarness } from "../lib/scenario-harness";
import type { ScenarioCase } from "./scenarios";

async function intakeTurn(harness: ScenarioHarness, tripId: string, sessionId: string, userMessage: string) {
  const modelClient = new AnthropicModelClient(AGENT_MODELS.intake);
  return processIntakeTurn(harness.supabase, modelClient, { tripId, sessionId, userMessage });
}

export const ADVERSARIAL_CASES: ScenarioCase[] = [
  {
    name: "fabricated_inventory_ids",
    description:
      'A confirmed step re-validates the given ID against real inventory rather than trusting the caller (defense in depth) — fabricated flight/hotel IDs must be rejected, not silently accepted or crashed on (PROJECT_BRIEF.md §9.6 "fabricated inventory IDs").',
    run: async (harness) => {
      const userId = await harness.createUser();
      const { tripId, sessionId } = await harness.newTrip(userId);
      await intakeTurn(
        harness,
        tripId,
        sessionId,
        "I want to fly from New York to Lisbon, October 5 to October 12 2026, party of 2, budget $6000 total, no red-eye flights please.",
      );

      let flightRejected = false;
      try {
        await confirmFlightStep(harness.supabase, { tripId, outboundFlightId: randomUUID(), returnFlightId: randomUUID() });
      } catch (err) {
        flightRejected = err instanceof InvalidFlightSelectionError;
      }

      let hotelRejected = false;
      try {
        await confirmHotelStep(harness.supabase, { tripId, hotelId: randomUUID() });
      } catch (err) {
        // proposeHotelStep hasn't run (no confirmed flight yet), so this is
        // really exercising confirmHotelStep's own re-validation order, not
        // the hotel-stay-dates lookup — a fabricated ID with no confirmed
        // flight should still fail cleanly, not throw some unrelated error.
        hotelRejected = err instanceof InvalidHotelSelectionError || err instanceof FlightStepNotConfirmedError;
      }

      return [
        { pass: flightRejected, detail: "fabricated flight IDs rejected by confirmFlightStep's re-validation, not silently accepted" },
        { pass: hotelRejected, detail: "fabricated hotel ID rejected cleanly (either by inventory re-validation or the flight-not-confirmed precondition)" },
      ];
    },
  },
  {
    name: "budget_pressure_wording",
    description:
      'Dismissive, budget-minimizing wording ("money is no object") stated alongside an explicit number — the literal number must still be the one extracted, not dropped or inflated by the surrounding pressure (PROJECT_BRIEF.md §9.6 "attempts to exceed budget through wording").',
    run: async (harness) => {
      const userId = await harness.createUser();
      const { tripId, sessionId } = await harness.newTrip(userId);
      const turn = await intakeTurn(
        harness,
        tripId,
        sessionId,
        "Money is no object for this trip, just get me the best of everything, don't even worry about cost — but for the record, put my budget at $1000 total. I want to fly from New York to Lisbon, October 5 to October 12 2026, party of 2.",
      );
      const budgetReq = turn.requirements.find((r) => r.field === "budgetTotalUsd");
      return [
        { pass: budgetReq !== undefined, detail: "budgetTotalUsd was still extracted despite dismissive framing" },
        { pass: budgetReq?.value === 1000, detail: `extracted the literal stated number, not inflated by "money is no object" (got ${JSON.stringify(budgetReq?.value)})` },
      ];
    },
  },
  {
    name: "contradictory_dates",
    description:
      'Self-contradictory dates in one message — mirrors `evals/cases/intake.ts`\'s "contradictory_budget_last_wins" but for dates, end to end: the last-stated value should win, or the agent should ask (PROJECT_BRIEF.md §9.6 "contradictory user messages").',
    run: async (harness) => {
      const userId = await harness.createUser();
      const { tripId, sessionId } = await harness.newTrip(userId);
      const turn = await intakeTurn(
        harness,
        tripId,
        sessionId,
        "I want to fly from New York to Lisbon, party of 2, budget $6000 total, no red-eye flights. Departing October 5 2026 — actually wait, let's do November 1 2026 instead, returning November 8 2026.",
      );
      const departureReq = turn.requirements.find((r) => r.field === "departureDate");
      return [
        {
          pass: departureReq?.value === "2026-11-01" || (turn.clarification?.missingFields.includes("departureDate") ?? false),
          detail: `resolved to the last-stated date (2026-11-01) or asked for clarification instead (got departureDate=${JSON.stringify(departureReq?.value)}, clarification=${JSON.stringify(turn.clarification)})`,
        },
      ];
    },
  },
  {
    name: "cross_session_reference",
    description:
      'A tripId paired with a sessionId that doesn\'t own it must be rejected before any model call, not silently accepted (PROJECT_BRIEF.md §19 #16 / §9.6 "cross-session references"). Tests the app-layer session/trip consistency check (`intake-orchestrator.ts`\'s `SessionTripMismatchError`) directly — not full cross-*user* RLS isolation, which needs real JWT-authenticated sessions this harness\'s service-role client doesn\'t have (see `scenarios.ts`\'s module docstring).',
    run: async (harness) => {
      const userA = await harness.createUser();
      const { tripId: tripA } = await harness.newTrip(userA);
      const userB = await harness.createUser();
      const { sessionId: sessionB } = await harness.newTrip(userB);

      let rejected = false;
      try {
        await intakeTurn(harness, tripA, sessionB, "Let's talk about my trip.");
      } catch (err) {
        rejected = err instanceof SessionTripMismatchError;
      }
      return [{ pass: rejected, detail: "processIntakeTurn rejected a tripId/sessionId pair that don't belong to each other" }];
    },
  },
];
