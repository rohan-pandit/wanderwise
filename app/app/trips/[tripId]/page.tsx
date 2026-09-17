import { notFound } from "next/navigation";
import { createClient } from "@/src/config/supabase/server";
import { ChatPanel, type ChatMessage } from "../../_components/chat-panel";
import { ItineraryPanel } from "../../_components/itinerary-panel";

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

  return (
    <div className="flex min-h-0 flex-1">
      <ChatPanel tripId={trip.id} initialMessages={initialMessages} />
      <ItineraryPanel tripId={trip.id} />
    </div>
  );
}
