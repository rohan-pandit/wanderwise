import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import { unwrapOrThrow } from "./shared";

export type Session = Database["public"]["Tables"]["sessions"]["Row"];

export async function createSession(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Session> {
  return unwrapOrThrow(
    supabase.from("sessions").insert({ user_id: userId }).select().single(),
  );
}

export async function getSession(
  supabase: SupabaseClient<Database>,
  sessionId: string,
): Promise<Session | null> {
  return unwrapOrThrow(
    supabase.from("sessions").select("*").eq("id", sessionId).maybeSingle(),
  );
}
