import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/src/config/supabase/server";
import { SignOutButton } from "./_components/sign-out-button";

/**
 * Protected shell for everything under /app. Middleware already redirects
 * signed-out requests, but this check is defense in depth (per
 * PROJECT_BRIEF.md §6.6, server-side authorization checks) in case this
 * layout is ever reached a way that bypasses middleware.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/");
  }

  return (
    <div className="flex flex-1 flex-col">
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
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  );
}
