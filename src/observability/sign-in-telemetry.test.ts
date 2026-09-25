import { describe, expect, it } from "vitest";
import { classifyCallbackFailure, summarizeSignInProblems, type CallbackFailureInput } from "./sign-in-telemetry";

describe("summarizeSignInProblems", () => {
  it("lists failures newest first and finds emails whose latest link was never used", () => {
    const problems = summarizeSignInProblems([
      { event_type: "sign_in_link_requested", email: "dan@example.com", payload: {}, created_at: "2026-09-25T10:00:00Z" },
      { event_type: "sign_in_succeeded", email: "dan@example.com", payload: {}, created_at: "2026-09-25T10:01:00Z" },
      { event_type: "sign_in_link_requested", email: "amy@example.com", payload: {}, created_at: "2026-09-25T11:00:00Z" },
      { event_type: "sign_in_link_requested", email: "amy@example.com", payload: {}, created_at: "2026-09-25T11:05:00Z" },
      { event_type: "auth_callback_failed", email: null, payload: { reason: "link_rejected", detail: "otp_expired" }, created_at: "2026-09-25T11:02:00Z" },
      { event_type: "auth_callback_failed", email: null, payload: { reason: "different_browser", detail: null }, created_at: "2026-09-25T11:06:00Z" },
      { event_type: "sign_in_link_failed", email: "bob@example.com", payload: { message: "rate limit" }, created_at: "2026-09-25T09:00:00Z" },
      // Dan asks again later and doesn't come back: counts as unused again.
      { event_type: "sign_in_link_requested", email: "Dan@Example.com", payload: {}, created_at: "2026-09-25T12:00:00Z" },
    ]);

    expect(problems.callbackFailures.map((f) => f.reason)).toEqual(["different_browser", "link_rejected"]);
    expect(problems.linkFailures).toEqual([{ at: "2026-09-25T09:00:00Z", email: "bob@example.com", message: "rate limit" }]);
    expect(problems.unusedLinks).toEqual([
      { email: "dan@example.com", lastRequestedAt: "2026-09-25T12:00:00Z", requestCount: 2 },
      { email: "amy@example.com", lastRequestedAt: "2026-09-25T11:05:00Z", requestCount: 2 },
    ]);
  });
});

const base: CallbackFailureInput = {
  hasCode: true,
  providerErrorCode: null,
  providerErrorDescription: null,
  exchangeErrorCode: null,
  exchangeErrorMessage: null,
  verifierCookiePresent: true,
};

describe("classifyCallbackFailure", () => {
  it("reports a link Supabase itself rejected, e.g. expired", () => {
    expect(classifyCallbackFailure({ ...base, hasCode: false, providerErrorCode: "otp_expired", providerErrorDescription: "Email link is invalid or has expired" })).toEqual({
      reason: "link_rejected",
      detail: "otp_expired: Email link is invalid or has expired",
    });
  });

  it("blames a different browser when the PKCE verifier cookie is missing", () => {
    expect(classifyCallbackFailure({ ...base, verifierCookiePresent: false, exchangeErrorCode: "bad_code_verifier", exchangeErrorMessage: "invalid request" })).toEqual({
      reason: "different_browser",
      detail: "bad_code_verifier: invalid request",
    });
  });

  it("falls back to a plain exchange failure when the verifier was present", () => {
    expect(classifyCallbackFailure({ ...base, exchangeErrorMessage: "flow state expired" })).toEqual({ reason: "exchange_failed", detail: "flow state expired" });
  });

  it("notices a callback with no code at all", () => {
    expect(classifyCallbackFailure({ ...base, hasCode: false })).toEqual({ reason: "missing_code", detail: null });
  });
});
