import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import { unwrapOrThrow } from "./shared";

export type FeedbackRow = Database["public"]["Tables"]["feedback"]["Row"];

export interface NewFeedback {
  tripId: string;
  /** `FEEDBACK_CATEGORY_OPTIONS` values (`app/app/_components/feedback-widget.tsx`) — free-form on this side of the boundary since a category set is UI vocabulary, not something this table needs to validate. */
  categories: string[];
  message: string | null;
  /** Where the user was when they reported it, e.g. "chain step: flight" / "finalized" / "cancelled" — computed server-side (`app/app/actions.ts`'s `submitFeedback`) from the trip's own decisions, never trusted from the client. */
  context: string;
}

export async function recordFeedback(
  supabase: SupabaseClient<Database>,
  feedback: NewFeedback,
): Promise<FeedbackRow> {
  return unwrapOrThrow(
    supabase
      .from("feedback")
      .insert({
        trip_id: feedback.tripId,
        categories: feedback.categories,
        message: feedback.message,
        context: feedback.context,
      })
      .select()
      .single(),
  );
}

/** Every submitted report, newest first — read with the service-role client for the aggregate internal view (`/internal/product-metrics`), same reasoning as that page's other cross-user reads (RLS on `feedback` scopes to one trip's owner, but the dashboard needs every user's). */
export async function listAllFeedback(supabase: SupabaseClient<Database>): Promise<FeedbackRow[]> {
  return unwrapOrThrow(
    supabase.from("feedback").select("*").order("created_at", { ascending: false }),
  );
}
