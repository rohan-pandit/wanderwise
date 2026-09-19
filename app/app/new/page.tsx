"use client";

/**
 * The naming step between the landing screen (`/app`) and a trip's chat +
 * itinerary workspace (`/app/trips/[identifier]`) — naming is required (the
 * user's explicit call, 2026-09-19), so this is the one place `createTripAction`
 * (`app/app/actions.ts`) is ever called from. The trip exists for real the
 * moment this submits; `ChatPanel` on the destination page always receives a
 * real `tripId` and never creates one itself anymore. Routes to the trip's
 * `slug`, not its raw id, so the URL reads as `/app/trips/lisbon-getaway`.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { createTripAction } from "../actions";
import { Spinner } from "../_components/spinner";

export default function NewTripPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable across retries of the same submit attempt, mirroring the old
  // `startCorrelationId` pattern `ChatPanel` used to own — see
  // `createTripAction`'s own docstring for why.
  const correlationIdRef = useRef<string | null>(null);
  function correlationId(): string {
    if (!correlationIdRef.current) correlationIdRef.current = crypto.randomUUID();
    return correlationIdRef.current;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || pending) return;

    setPending(true);
    setError(null);
    try {
      const { slug } = await createTripAction({ name: trimmed, correlationId: correlationId() });
      router.push(`/app/trips/${slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong — try again.");
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="flex w-full max-w-md flex-col">
        <Link href="/app" className="self-start text-sm text-navy-400 hover:text-teal-700">
          ← Back
        </Link>

        <h1 className="mt-6 font-serif text-3xl font-semibold text-navy-900">
          What should we call this trip?
        </h1>
        <p className="mt-2.5 text-sm text-navy-400">You can always rename it later.</p>

        <form onSubmit={handleSubmit} className="mt-7 flex flex-col">
          <label htmlFor="trip-name" className="sr-only">
            Trip name
          </label>
          <input
            id="trip-name"
            type="text"
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={pending}
            placeholder="e.g. Lisbon getaway"
            className="w-full rounded-lg border border-sand-300 bg-transparent px-4 py-3.5 text-lg text-navy-900 outline-none focus:border-navy-400 disabled:opacity-50"
          />

          {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

          <button
            type="submit"
            disabled={pending || !name.trim()}
            className="mt-5 inline-flex items-center gap-1.5 self-start rounded-lg bg-terracotta-600 px-6 py-3 text-sm font-semibold text-sand-50 transition-colors hover:bg-terracotta-700 disabled:opacity-40"
          >
            {pending ? (
              <>
                <Spinner /> Starting…
              </>
            ) : (
              "Continue"
            )}
          </button>
        </form>
      </div>
    </main>
  );
}
