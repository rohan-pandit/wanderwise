import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Routes that don't require a signed-in user. Everything else is
 * protected by default — deliberately deny-by-default rather than an
 * allowlist of protected prefixes (e.g. "/app"), so a new route (an API
 * endpoint under /api/, say) is secure the moment it's added instead of
 * only if someone remembers to prefix it correctly.
 */
const PUBLIC_PATHS = new Set(["/", "/auth/callback"]);

/**
 * `/internal/*` (engineering/product dashboards) additionally requires the
 * signed-in user's email to match `INTERNAL_ACCESS_EMAIL`. This narrows the
 * "any signed-in user" bar those pages previously relied on (see
 * app/internal/analytics/page.tsx's docstring for why that was the original,
 * deliberate call) now that the app is reachable by more than its single
 * operator. Fails closed: an unset env var denies everyone rather than
 * silently falling back to "any signed-in user."
 */
const INTERNAL_PREFIX = "/internal";

/**
 * Runs on every request (Next.js 16 "proxy", formerly "middleware").
 * Refreshes the Supabase auth session (required by @supabase/ssr so
 * server components always see a valid session) and enforces the auth
 * boundary at the routing layer, per
 * docs/architecture/ADR-003-state-and-data-model.md.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !PUBLIC_PATHS.has(request.nextUrl.pathname)) {
    const redirectUrl = new URL("/", request.url);
    redirectUrl.searchParams.set("redirectTo", request.nextUrl.pathname);
    return NextResponse.redirect(redirectUrl);
  }

  if (user && request.nextUrl.pathname.startsWith(INTERNAL_PREFIX)) {
    const allowedEmail = process.env.INTERNAL_ACCESS_EMAIL?.toLowerCase();
    if (!allowedEmail || user.email?.toLowerCase() !== allowedEmail) {
      return NextResponse.redirect(new URL("/app", request.url));
    }
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
