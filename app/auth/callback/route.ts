import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/src/config/supabase/server";
import { createServiceClient } from "@/src/config/supabase/service";
import { recordAppEvent, truncateMessage } from "@/src/repositories/app-events";
import { classifyCallbackFailure } from "@/src/observability/sign-in-telemetry";

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
 *
 * Both outcomes are recorded to `app_events` for `/internal/users`
 * (ADR-007, Phase B): each successful sign-in (Supabase itself keeps only
 * the latest), and each failure with a classified reason. Recording is
 * best-effort and never changes where the user is sent.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const requestedRedirect = searchParams.get("redirectTo");
  const redirectTo =
    requestedRedirect && isSafeRedirectPath(requestedRedirect)
      ? requestedRedirect
      : "/app";

  let exchangeError: { code?: string; message: string } | null = null;
  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      await recordAppEvent(createServiceClient(), {
        eventType: "sign_in_succeeded",
        userId: data.user?.id ?? null,
        email: data.user?.email?.toLowerCase() ?? null,
      });
      return NextResponse.redirect(`${origin}${redirectTo}`);
    }
    exchangeError = error;
  }

  const failure = classifyCallbackFailure({
    hasCode: Boolean(code),
    providerErrorCode: searchParams.get("error_code"),
    providerErrorDescription: searchParams.get("error_description"),
    exchangeErrorCode: exchangeError?.code ?? null,
    exchangeErrorMessage: exchangeError?.message ?? null,
    verifierCookiePresent: request.cookies.getAll().some((c) => c.name.endsWith("-code-verifier")),
  });
  await recordAppEvent(createServiceClient(), {
    eventType: "auth_callback_failed",
    payload: { reason: failure.reason, detail: failure.detail ? truncateMessage(failure.detail) : null },
  });

  const errorUrl = new URL("/", origin);
  errorUrl.searchParams.set("error", "auth_callback_failed");
  return NextResponse.redirect(errorUrl);
}
