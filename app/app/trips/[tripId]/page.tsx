import { notFound } from "next/navigation";
import { createClient } from "@/src/config/supabase/server";
import { REQUIRED_FOR_READY, checkDatesNotInThePast, type RequirementFieldName } from "@/src/domain/extraction";
import { listActiveTripRequirements } from "@/src/repositories/trip-requirements";
import { checkAirportReadiness } from "@/src/workflow/step-shared";
import { type ChatMessage } from "../../_components/chat-panel";
import { TripWorkspace } from "../../_components/trip-workspace";

/**
 * A specific trip's chat + live itinerary, resumed. RLS enforces ownership —
 * a trip belonging to another user simply won't be returned by this query,
 * so we don't need a separate authorization check here.
 */
export default async function TripPage({
  params,
}: {
  params: Promise<{ tripId: string }>;
}) {
  const { tripId } = await params;
  const supabase = await createClient();
  const { data: trip, error } = await supabase
    .from("trips")
    .select("id, session_id, status, created_at")
    .eq("id", tripId)
    .single();

  if (error) {
    // PGRST116 = "no rows returned" from .single() — genuinely not found
    // (or not owned by this user, which RLS makes indistinguishable from
    // not existing). Any other error is a real failure and should surface
    // as one, not be swallowed into a misleading 404.
    if (error.code === "PGRST116") {
      notFound();
    }
    throw error;
  }

  const { data: messageRows } = await supabase
    .from("messages")
    .select("role, content")
    .eq("session_id", trip.session_id)
    .order("created_at", { ascending: true });
  const initialMessages: ChatMessage[] = (messageRows ?? []).map((m) => ({
    role: m.role as ChatMessage["role"],
    content: m.content,
  }));

  // `ItineraryPanel` must not attempt to search flights before the trip's
  // requirements are actually complete (`RequirementsNotReadyError` — found
  // live 2026-09-18: a trip created from an under-specified first message,
  // e.g. destination + dates but no budget, redirects here immediately, and
  // without this check the panel would try to propose a flight step before
  // the user had finished answering the intake agent's clarifying
  // questions).
  //
  // Originally computed via basic field-presence alone
  // (`REQUIRED_FOR_READY.every(...)`), matching `checkRequirementsComplete`
  // — but `processIntakeTurn`'s own `effectiveReady` (`intake-orchestrator.ts`)
  // is stricter than that: it also requires no pending past-date or
  // airport-disambiguation clarification. This page's computation was never
  // updated to match when airport disambiguation was added later, so a
  // brand-new trip whose very first message has every base field present
  // but an ambiguous origin city (e.g. "New York" → JFK or LGA) landed here
  // with `initialRequirementsReady: true` — one turn before the server
  // actually considers requirements ready — and the itinerary panel's
  // auto-propose effect searched immediately, before the airport question
  // was even answered. Found live 2026-09-18 doing a UI design review: the
  // itinerary panel showed a "no flights match" error and a stuck "Finding
  // flights…" placeholder simultaneously, right after the trip's first
  // message, before the airport clarification had been answered. Fixed by
  // mirroring `effectiveReady`'s exact three conditions here.
  const requirementRows = await listActiveTripRequirements(supabase, trip.id);
  const presentFields = new Set(requirementRows.map((r) => r.field));
  const completenessReady = REQUIRED_FOR_READY.every((field) => presentFields.has(field));
  const reqsMap = new Map(requirementRows.map((r) => [r.field as RequirementFieldName, r.value]));
  const today = new Date().toISOString().slice(0, 10);
  const hasPastDate = completenessReady && checkDatesNotInThePast(reqsMap, today).length > 0;
  const hasPendingAirport =
    completenessReady && !hasPastDate && (await checkAirportReadiness(supabase, reqsMap, trip.id)).length > 0;
  const initialRequirementsReady = completenessReady && !hasPastDate && !hasPendingAirport;

  return (
    <TripWorkspace
      tripId={trip.id}
      initialMessages={initialMessages}
      initialTripStatus={trip.status}
      initialRequirementsReady={initialRequirementsReady}
    />
  );
}
