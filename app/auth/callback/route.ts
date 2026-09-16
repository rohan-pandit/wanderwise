import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/src/config/supabase/server";

/**
 * True if `path` is safe to redirect to after sign-in: a same-origin,
 * relative path. Rejects protocol-relative ("//evil.com") and absolute
 * URLs so an attacker-controlled redirectTo query param can't send a
 * successfully-authenticated user off-site (open redirect).
 */
function isSafeRedirectPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("://");
}

/**
 * Completes the Supabase magic-link sign-in: exchanges the emailed code
 * for a session, then redirects into the app.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const requestedRedirect = searchParams.get("redirectTo");
  const redirectTo =
    requestedRedirect && isSafeRedirectPath(requestedRedirect)
      ? requestedRedirect
      : "/app";

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
