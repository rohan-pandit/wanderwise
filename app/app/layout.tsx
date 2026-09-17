import Link from "next/link";
import { SignOutButton } from "./_components/sign-out-button";

/**
 * Shell for everything under /app. The auth check itself lives solely in
 * proxy.ts — it already redirects every signed-out request before it
 * reaches this layout, so re-checking here would just be a second
 * Supabase Auth network round-trip per request with no added protection.
 * The real defense in depth for user *data* is Row Level Security (see
 * supabase/migrations/0001_initial_schema.sql), the same pattern
 * app/app/trips/[tripId]/page.tsx already relies on.
 */
export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <Link
          href="/app"
          className="text-sm font-semibold tracking-tight text-black dark:text-zinc-50"
        >
          Wanderwise
        </Link>
        <nav className="flex items-center gap-4">
          <Link
            href="/app/trips"
            className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Your trips
          </Link>
          <SignOutButton />
        </nav>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
