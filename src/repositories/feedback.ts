import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import type { FeedbackKind } from "@/src/domain/feedback-categories";
import { unwrapOrThrow } from "./shared";

export type FeedbackRow = Database["public"]["Tables"]["feedback"]["Row"];

export interface NewFeedback {
  userId: string;
  /** Set only when the report came from inside a trip workspace — beta feedback can come from any `/app` page (migration 0020). */
  tripId: string | null;
  kind: FeedbackKind;
  /** `FEEDBACK_CATEGORY_OPTIONS` values (`src/domain/feedback-categories.ts`) — free-form on this side of the boundary since a category set is UI vocabulary, not something this table needs to validate. */
  categories: string[];
  message: string | null;
  /** Where the user was when they reported it, e.g. "chain step: flight" / "finalized" / "cancelled" / "no trip" — computed server-side (`app/app/actions.ts`'s `submitFeedback`) from the trip's own decisions, never trusted from the client. */
  context: string;
  /** The `/app` path the client says it was on — already passed through `sanitizeFeedbackRoute`. */
  route: string | null;
}

export async function recordFeedback(
  supabase: SupabaseClient<Database>,
  feedback: NewFeedback,
): Promise<FeedbackRow> {
  return unwrapOrThrow(
    supabase
      .from("feedback")
      .insert({
        user_id: feedback.userId,
        trip_id: feedback.tripId,
        kind: feedback.kind,
        categories: feedback.categories,
        message: feedback.message,
        context: feedback.context,
        route: feedback.route,
      })
      .select()
      .single(),
  );
}
