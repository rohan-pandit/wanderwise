import Link from "next/link";
import { cookies } from "next/headers";
import { SignOutButton } from "./_components/sign-out-button";
import { BetaProvider } from "./_components/beta-context";
import { BetaBanner, BetaChip, HeaderFeedbackLink } from "./_components/beta-callouts";
import { BETA_BANNER_COOKIE, isBetaBannerDismissed } from "@/src/config/beta";

/**
 * Shell for everything under /app. The auth check itself lives solely in
 * proxy.ts — it already redirects every signed-out request before it
 * reaches this layout, so re-checking here would just be a second
 * Supabase Auth network round-trip per request with no added protection.
 * The real defense in depth for user *data* is Row Level Security (see
 * supabase/migrations/0001_initial_schema.sql), the same pattern
 * app/app/trips/[identifier]/page.tsx already relies on.
 *
 * Also hosts the beta callouts (`beta-callouts.tsx`) — the header is the
 * one element on every /app page and sits outside the trip workspace's
 * layout-mode logic, so nothing here floats over chat or the itinerary
 * drawer. The banner cookie is read here (every /app route is already
 * dynamic, per-user) so a dismissed banner never flashes back in on load.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const bannerDismissed = isBetaBannerDismissed(cookieStore.get(BETA_BANNER_COOKIE)?.value);

  return (
    <BetaProvider initialBannerDismissed={bannerDismissed}>
      <div className="flex min-h-0 flex-1 flex-col">
        <BetaBanner />
        <header className="flex items-center justify-between gap-3 border-b border-sand-200 bg-sand-50 px-4 py-4 sm:px-6 sm:py-5">
          <div className="flex items-center gap-2 sm:gap-3">
            <Link
              href="/app"
              className="font-serif text-lg font-semibold tracking-tight text-navy-900 sm:text-2xl"
            >
              Wanderwise
            </Link>
            <BetaChip />
          </div>
          <nav className="flex items-center gap-4 sm:gap-6">
            <HeaderFeedbackLink />
            <Link
              href="/app/trips"
              className="text-sm text-navy-400 hover:text-teal-700 sm:text-base"
            >
              Your trips
            </Link>
            <SignOutButton />
          </nav>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </BetaProvider>
  );
}
