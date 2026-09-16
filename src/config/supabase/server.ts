import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cache } from "react";
import type { Database } from "./database.types";

/**
 * Supabase client for use in Server Components, Server Actions, and Route
 * Handlers. Uses the anon key + the caller's session cookie, so RLS applies
 * exactly as it would for that authenticated user — this is NOT the
 * service-role client.
 *
 * Wrapped in React's `cache()` so every Server Component in the same
 * request shares one client (and one `getUser()` session lookup) instead
 * of each caller paying for its own — this matters more as later phases
 * add more components (chat panel, itinerary panel, sidebar, ...) that
 * each need a client.
 */
export const createClient = cache(async () => {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component (no cookie write access) —
            // safe to ignore as long as proxy.ts is refreshing sessions.
          }
        },
      },
    },
  );
});
