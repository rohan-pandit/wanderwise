"use client";

import { useState, type FormEvent } from "react";
import { createClient } from "@/src/config/supabase/client";
import { BETA_ENABLED } from "@/src/config/beta";

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

    try {
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
    } catch (err) {
      // `signInWithOtp` normally *resolves* with `{ error }` for an
      // API-level failure (including a rate-limit rejection) — this only
      // catches a genuine network-level failure (DNS, connectivity drop),
      // which would otherwise reject the promise and leave `status` stuck
      // on "sending" forever with no feedback at all (found live
      // 2026-09-19: testing from a phone over a local network, "nothing
      // happens" after submitting).
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong — try again.");
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-sand-50 px-6 font-sans">
      <main className="w-full max-w-sm">
        <p className="flex items-center gap-2 text-xs font-medium tracking-[0.2em] text-terracotta-600 uppercase">
          AI-assisted trip planning
          {BETA_ENABLED ? (
            <span className="rounded-full border border-terracotta-200 bg-terracotta-50 px-2 py-0.5 text-[11px] font-semibold tracking-[0.12em]">
              Beta
            </span>
          ) : null}
        </p>
        <h1 className="mt-2 font-serif text-4xl font-semibold tracking-tight text-navy-900">
          Wanderwise
        </h1>
        <p className="mt-3 text-sm leading-6 text-navy-700">
          A travel-planning concierge that helps you plan and book your
          dream trip.
        </p>

        <div className="mt-8 rounded-2xl border border-sand-200 bg-sand-100 p-6 shadow-sm">
          {status === "sent" ? (
            <p className="text-sm text-navy-700">
              Check your inbox — we sent a sign-in link to <strong>{email}</strong>.
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
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
                // `text-base` (16px), not `text-sm` — iOS Safari auto-zooms
                // the whole page on focus for any input under 16px, which is
                // what was cutting off unrelated UI (found live on a phone:
                // the header nav and chat bubbles were getting clipped once
                // the keyboard opened, purely because the page had zoomed).
                className="rounded-full border border-sand-300 bg-sand-50 px-4 py-2.5 text-base text-navy-900 outline-none focus:border-teal-600"
              />
              <button
                type="submit"
                disabled={status === "sending"}
                className="rounded-full bg-teal-700 px-5 py-2.5 text-sm font-medium text-sand-50 transition-colors hover:bg-teal-800 disabled:opacity-60"
              >
                {status === "sending" ? "Sending..." : "Send magic link"}
              </button>
              {status === "error" && errorMessage ? (
                <p className="text-sm text-red-600">
                  {errorMessage}
                </p>
              ) : null}
            </form>
          )}
        </div>

        <p className="mt-6 text-xs text-navy-400">
          No password, ever — just click the link in your email.
        </p>
      </main>
    </div>
  );
}
