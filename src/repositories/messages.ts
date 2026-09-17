import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import { unwrapOrThrow } from "./shared";

export type Message = Database["public"]["Tables"]["messages"]["Row"];

export interface NewMessage {
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** Idempotency key (`processIntakeTurn`'s per-role derived correlation ID, `src/workflow/intake-orchestrator.ts`) — see `findMessageByCorrelationId`. */
  correlationId?: string;
}

/**
 * Raw chat history for UI continuity only (PROJECT_BRIEF.md §6.3) — never
 * what an agent reasons over. Agents receive a structured trip-state slice
 * (requirements/preferences/decisions), not this transcript.
 */
export async function appendMessage(
  supabase: SupabaseClient<Database>,
  message: NewMessage,
): Promise<Message> {
  return unwrapOrThrow(
    supabase
      .from("messages")
      .insert({
        session_id: message.sessionId,
        role: message.role,
        content: message.content,
        correlation_id: message.correlationId ?? null,
      })
      .select()
      .single(),
  );
}

/** Looks up a message by its per-role correlation ID (`messages.correlation_id`, `0009_messages_correlation_id.sql`) — a retried turn checks this before re-appending, so the same chat bubble isn't shown twice. Best-effort, no DB uniqueness constraint (matching `trip_events`/`workflow_steps`' existing correlation_id columns) — this is chat history for UI continuity, not the strictly-consistent source of truth. */
export async function findMessageByCorrelationId(
  supabase: SupabaseClient<Database>,
  sessionId: string,
  correlationId: string,
): Promise<Message | null> {
  return unwrapOrThrow(
    supabase
      .from("messages")
      .select("*")
      .eq("session_id", sessionId)
      .eq("correlation_id", correlationId)
      .maybeSingle(),
  );
}

export async function listMessages(
  supabase: SupabaseClient<Database>,
  sessionId: string,
): Promise<Message[]> {
  return unwrapOrThrow(
    supabase
      .from("messages")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true }),
  );
}
