"use server";

import { createServiceClient } from "@/src/config/supabase/service";
import { normalizeEmail, recordAppEvent, truncateMessage } from "@/src/repositories/app-events";

export interface SignInLinkRequestReport {
  email: string;
  /** `signInWithOtp`'s error message, or `null` when Supabase accepted the request. */
  error: string | null;
}

/**
 * Records a magic-link request from the sign-in page (`app/page.tsx`) to
 * `app_events`. `signInWithOtp` runs in the browser (the PKCE verifier has
 * to live there), so without this the server never sees a request, or a
 * failed one such as a rate limit. Paired with `sign_in_succeeded` from
 * `/auth/callback`, it shows who asked for a link and never came back.
 *
 * Deliberately public, since the person isn't signed in yet. So the input
 * is untrusted: the email must look like one (`normalizeEmail`) or nothing
 * is written, and the message is length-capped. Anyone could still write
 * made-up "requests"; that only pollutes an internal beta dashboard and is
 * accepted for now (ADR-007).
 */
export async function recordSignInLinkRequest(report: SignInLinkRequestReport): Promise<void> {
  const email = normalizeEmail(report?.email);
  if (!email) return;
  const error = typeof report.error === "string" && report.error ? truncateMessage(report.error) : null;
  await recordAppEvent(createServiceClient(), {
    eventType: error ? "sign_in_link_failed" : "sign_in_link_requested",
    email,
    payload: error ? { message: error } : {},
  });
}
