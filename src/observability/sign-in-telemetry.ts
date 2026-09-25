/**
 * Why a magic-link sign-in failed at `/auth/callback`, in words the
 * `/internal/users` page can show. A failed callback usually can't say
 * *who* it was (a bad or expired code identifies nobody), so the reason is
 * the useful part. Pure, so it's tested without a request.
 */
export interface CallbackFailureInput {
  /** `?code=` was present. */
  hasCode: boolean;
  /** Supabase redirects here with `?error_code=` (e.g. `otp_expired`) when the link itself was rejected. */
  providerErrorCode: string | null;
  providerErrorDescription: string | null;
  /** `exchangeCodeForSession` error, when the code was there but the exchange failed. */
  exchangeErrorCode: string | null;
  exchangeErrorMessage: string | null;
  /**
   * The PKCE code-verifier cookie was sent. The link only works in the
   * browser that requested it, so a missing verifier almost always means
   * the link was opened somewhere else (another browser, or an email app's
   * built-in browser).
   */
  verifierCookiePresent: boolean;
}

export type CallbackFailureReason = "link_rejected" | "different_browser" | "exchange_failed" | "missing_code";

export function classifyCallbackFailure(input: CallbackFailureInput): { reason: CallbackFailureReason; detail: string | null } {
  if (input.providerErrorCode || input.providerErrorDescription) {
    return {
      reason: "link_rejected",
      detail: [input.providerErrorCode, input.providerErrorDescription].filter(Boolean).join(": "),
    };
  }
  if (!input.hasCode) return { reason: "missing_code", detail: null };
  const detail = [input.exchangeErrorCode, input.exchangeErrorMessage].filter(Boolean).join(": ") || null;
  if (!input.verifierCookiePresent) return { reason: "different_browser", detail };
  return { reason: "exchange_failed", detail };
}

export interface SignInEventRow {
  event_type: string;
  email: string | null;
  payload: unknown;
  created_at: string;
}

export interface SignInProblems {
  callbackFailures: { at: string; reason: string; detail: string | null }[];
  linkFailures: { at: string; email: string | null; message: string | null }[];
  /** Emails whose latest link request has no sign-in after it: the link was never used, or failed at the callback. */
  unusedLinks: { email: string; lastRequestedAt: string; requestCount: number }[];
}

function field(payload: unknown, key: string): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/** Newest first. Expects sign-in-related `app_events` rows only; anything else is ignored. */
export function summarizeSignInProblems(events: SignInEventRow[]): SignInProblems {
  const newestFirst = [...events].sort((a, b) => b.created_at.localeCompare(a.created_at));

  const callbackFailures = newestFirst
    .filter((e) => e.event_type === "auth_callback_failed")
    .map((e) => ({ at: e.created_at, reason: field(e.payload, "reason") ?? "unknown", detail: field(e.payload, "detail") }));

  const linkFailures = newestFirst
    .filter((e) => e.event_type === "sign_in_link_failed")
    .map((e) => ({ at: e.created_at, email: e.email, message: field(e.payload, "message") }));

  const requests = new Map<string, { last: string; count: number }>();
  const lastSignIn = new Map<string, string>();
  for (const e of events) {
    const email = e.email?.toLowerCase();
    if (!email) continue;
    if (e.event_type === "sign_in_link_requested") {
      const r = requests.get(email) ?? { last: e.created_at, count: 0 };
      r.count += 1;
      if (e.created_at > r.last) r.last = e.created_at;
      requests.set(email, r);
    } else if (e.event_type === "sign_in_succeeded") {
      const prev = lastSignIn.get(email);
      if (!prev || e.created_at > prev) lastSignIn.set(email, e.created_at);
    }
  }
  const unusedLinks = [...requests.entries()]
    .filter(([email, r]) => (lastSignIn.get(email) ?? "") < r.last)
    .map(([email, r]) => ({ email, lastRequestedAt: r.last, requestCount: r.count }))
    .sort((a, b) => b.lastRequestedAt.localeCompare(a.lastRequestedAt));

  return { callbackFailures, linkFailures, unusedLinks };
}

export const CALLBACK_FAILURE_LABELS: Record<CallbackFailureReason, string> = {
  link_rejected: "Link rejected (expired or already used)",
  different_browser: "Opened in a different browser than the one that requested it",
  exchange_failed: "Code exchange failed",
  missing_code: "Callback hit without a code",
};
