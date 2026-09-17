/**
 * Telemetry redaction (PROJECT_BRIEF.md §13.2: "do not store unrestricted
 * raw prompts or model outputs if they contain sensitive data. Use
 * redaction..."). Scoped narrowly: `requiredAccessibility` is the one
 * extracted field that can reveal a disability/health condition. Every
 * other field the Intake agent extracts (dates, budget, party size,
 * destination) is ordinary trip-shape data the dashboards
 * (`app/internal/analytics`, `app/internal/product-metrics`) need to show,
 * so it isn't touched.
 *
 * Decided Phase 9, 2026-09-17 (ADR-007) — see
 * `docs/IMPLEMENTATION_PLAN.md` §5 for why retention itself (time-based
 * deletion) is a documented, not-yet-automated policy rather than code here.
 */
import type { Json } from "@/src/config/supabase/database.types";

const SENSITIVE_FIELD_NAMES: ReadonlySet<string> = new Set(["requiredAccessibility"]);
const REDACTED = "[redacted]";

/**
 * Deep-walks a tool-call `arguments`/`result` payload and masks the `value`
 * of any object shaped like `{field: <sensitive>, value: ...}` (record_
 * extraction's requirement items) or `{target: <sensitive>, value: ...}`
 * (propose_trip_revision) — recursing through arrays/objects so it applies
 * uniformly regardless of which tool or nesting produced the payload.
 */
export function redactSensitiveTelemetry(node: Json): Json {
  if (Array.isArray(node)) {
    return node.map(redactSensitiveTelemetry);
  }
  if (node !== null && typeof node === "object") {
    const record = node as { [key: string]: Json | undefined };
    const isSensitive =
      (typeof record.field === "string" && SENSITIVE_FIELD_NAMES.has(record.field)) ||
      (typeof record.target === "string" && SENSITIVE_FIELD_NAMES.has(record.target));
    const next: { [key: string]: Json | undefined } = {};
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined) continue;
      next[key] = isSensitive && key === "value" ? REDACTED : redactSensitiveTelemetry(value);
    }
    return next;
  }
  return node;
}
