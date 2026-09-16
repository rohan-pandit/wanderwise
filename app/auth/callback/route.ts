import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/src/config/supabase/server";

/**
 * Completes the Supabase magic-link sign-in: exchanges the emailed code
 * for a session, then redirects into the app.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const redirectTo = searchParams.get("redirectTo") ?? "/app";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${redirectTo}`);
    }
  }

  const errorUrl = new URL("/", origin);
  errorUrl.searchParams.set("error", "auth_callback_failed");
  return NextResponse.redirect(errorUrl);
}
