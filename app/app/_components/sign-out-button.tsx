"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/src/config/supabase/client";

export function SignOutButton() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut() {
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signOut();
    if (error) {
      setError("Couldn't sign out — try again.");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      {error ? (
        <span className="text-sm text-red-600 dark:text-red-400">{error}</span>
      ) : null}
      <button
        onClick={handleSignOut}
        className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        Sign out
      </button>
    </div>
  );
}
