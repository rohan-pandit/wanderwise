import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import { unwrapOrThrow } from "./shared";

export type Message = Database["public"]["Tables"]["messages"]["Row"];

export interface NewMessage {
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
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
      .insert({ session_id: message.sessionId, role: message.role, content: message.content })
      .select()
      .single(),
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
