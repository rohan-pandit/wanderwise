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
        <span className="text-sm text-red-600">{error}</span>
      ) : null}
      <button
        onClick={handleSignOut}
        className="text-sm text-navy-400 hover:text-teal-700"
      >
        Sign out
      </button>
    </div>
  );
}
