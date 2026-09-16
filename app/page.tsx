"use client";

import { useState, type FormEvent } from "react";
import { createClient } from "@/src/config/supabase/client";

export default function Home() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("sending");
    setErrorMessage(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setStatus("error");
      setErrorMessage(error.message);
      return;
    }

    setStatus("sent");
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-6 font-sans dark:bg-black">
      <main className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Wanderwise
        </h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          A travel-planning concierge that reasons over a deterministic,
          testable planning engine — not a booking platform. Sign in to plan
          a trip.
        </p>

        {status === "sent" ? (
          <p className="mt-8 rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
            Check your inbox — we sent a sign-in link to <strong>{email}</strong>.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-3">
            <label htmlFor="email" className="sr-only">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="rounded-full border border-zinc-300 bg-white px-4 py-2.5 text-sm text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
            />
            <button
              type="submit"
              disabled={status === "sending"}
              className="rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-60 dark:hover:bg-[#ccc]"
            >
              {status === "sending" ? "Sending..." : "Send magic link"}
            </button>
            {status === "error" && errorMessage ? (
              <p className="text-sm text-red-600 dark:text-red-400">
                {errorMessage}
              </p>
            ) : null}
          </form>
        )}

        <p className="mt-6 text-xs text-zinc-500 dark:text-zinc-500">
          No password, ever — just click the link in your email.
        </p>
      </main>
    </div>
  );
}
