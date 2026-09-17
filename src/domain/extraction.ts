/**
 * Structured output schemas for the Intake and Revision Interpreter agent
 * (PROJECT_BRIEF.md §6.2 row A, §7.1, §12). Pure TypeScript/Zod, no model
 * calls — these are the contract the agent's tool calls are validated
 * against, and the deterministic completeness check that gates
 * `requirements_ready` (§8.1). Field vocabulary is deliberately narrow and
 * keyed to the hard constraints `src/domain/constraints.ts` and the search
 * params in `docs/IMPLEMENTATION_PLAN.md` §3 actually consume — a model
 * emitting a field outside this set fails validation rather than silently
 * being stored as an untyped string key.
 */
import { z } from "zod";
import { WEEKDAYS, toEpochDay } from "./dates";

// ---------------------------------------------------------------------------
// Requirements — hard musts (PROJECT_BRIEF.md §7.1). Each field has its own
// value type, enforced via a discriminated union so a model can't pair the
// wrong shape of value with a field (e.g. a string for `partySize`).
// ---------------------------------------------------------------------------

export const REQUIREMENT_FIELDS = [
  "origin",
  "destination",
  "departureDate",
  "returnDate",
  "partySize",
  "roomGroups",
  "budgetTotalUsd",
  "noRedEye",
  "maxFlightPriceUsd",
  "minHotelRating",
  "maxHotelPriceUsd",
  "refundableHotel",
  "requiredAccessibility",
  "excludeClosedOnDays",
  "maxActivityPriceUsd",
] as const;

export type RequirementFieldName = (typeof REQUIREMENT_FIELDS)[number];

// Delegates calendar-validity to `toEpochDay`, which rejects out-of-range
// dates like "2026-02-30" (not just malformed shapes) — this is a system
// boundary (model output entering the system), so it's worth the extra
// strictness rather than a bare shape regex.
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)")
  .refine((value) => {
    try {
      toEpochDay(value);
      return true;
    } catch {
      return false;
    }
  }, "must be a real calendar date");

const roomGroupSchema = z.object({
  occupants: z.number().int().min(1),
  label: z.string().min(1).optional(),
});

/** Source a model-extracted item can claim — the other three §7.2 provenance values are system/deterministic-only, never produced by this agent. */
export const ExtractionSource = z.enum(["user_explicit", "user_inferred"]);
export type ExtractionSource = z.infer<typeof ExtractionSource>;

const provenance = {
  source: ExtractionSource,
  confidence: z.number().min(0).max(1),
};

export const ExtractedRequirement = z.discriminatedUnion("field", [
  z.object({ field: z.literal("origin"), value: z.string().min(1), ...provenance }),
  z.object({ field: z.literal("destination"), value: z.string().min(1), ...provenance }),
  z.object({ field: z.literal("departureDate"), value: isoDate, ...provenance }),
  z.object({ field: z.literal("returnDate"), value: isoDate, ...provenance }),
  z.object({ field: z.literal("partySize"), value: z.number().int().min(1), ...provenance }),
  z.object({ field: z.literal("roomGroups"), value: z.array(roomGroupSchema).min(1), ...provenance }),
  // Currency is fixed at USD, matching the seed inventory (all `*_usd` columns) — see money.ts.
  z.object({ field: z.literal("budgetTotalUsd"), value: z.number().positive(), ...provenance }),
  z.object({ field: z.literal("noRedEye"), value: z.boolean(), ...provenance }),
  z.object({ field: z.literal("maxFlightPriceUsd"), value: z.number().positive(), ...provenance }),
  z.object({ field: z.literal("minHotelRating"), value: z.number().min(0).max(5), ...provenance }),
  z.object({ field: z.literal("maxHotelPriceUsd"), value: z.number().positive(), ...provenance }),
  z.object({ field: z.literal("refundableHotel"), value: z.boolean(), ...provenance }),
  z.object({
    field: z.literal("requiredAccessibility"),
    value: z.array(z.string().min(1)).min(1),
    ...provenance,
  }),
  z.object({
    field: z.literal("excludeClosedOnDays"),
    value: z.array(z.enum(WEEKDAYS)).min(1),
    ...provenance,
  }),
  z.object({ field: z.literal("maxActivityPriceUsd"), value: z.number().positive(), ...provenance }),
]);
export type ExtractedRequirement = z.infer<typeof ExtractedRequirement>;

/** Full stored shape (PROJECT_BRIEF.md §7.1's `req_123` example) — what a `trip_requirements` row becomes once the orchestrator persists an extraction. */
export interface RequirementRecord {
  id: string;
  field: RequirementFieldName;
  value: unknown;
  source: ExtractionSource;
  confidence: number;
  status: "active" | "confirmed" | "retracted";
  createdAt: string;
}

export function toRequirementRecord(
  extracted: ExtractedRequirement,
  opts: { id: string; createdAt: string; status?: RequirementRecord["status"] },
): RequirementRecord {
  return {
    id: opts.id,
    field: extracted.field,
    value: extracted.value,
    source: extracted.source,
    confidence: extracted.confidence,
    status: opts.status ?? "active",
    createdAt: opts.createdAt,
  };
}

/** Fields required before the workflow can leave `collecting_requirements` (PROJECT_BRIEF.md §8.1). Deterministic — not an agent judgment call. */
export const REQUIRED_FOR_READY: readonly RequirementFieldName[] = [
  "origin",
  "destination",
  "departureDate",
  "partySize",
  "budgetTotalUsd",
];

export interface CompletenessResult {
  ready: boolean;
  missingFields: RequirementFieldName[];
}

/** A retracted requirement no longer counts as present. `active` and `confirmed` both do — confirmation is a separate concern from completeness. */
export function checkRequirementsComplete(records: RequirementRecord[]): CompletenessResult {
  const present = new Set(
    records.filter((r) => r.status !== "retracted").map((r) => r.field),
  );
  const missingFields = REQUIRED_FOR_READY.filter((field) => !present.has(field));
  return { ready: missingFields.length === 0, missingFields };
}

// ---------------------------------------------------------------------------
// Preferences — soft wants (PROJECT_BRIEF.md §7.1). Qualitative and
// trade-away-able, so the field vocabulary stays looser than requirements:
// these feed Phase 5 retrieval (vibe tags) rather than a deterministic
// constraint check, but are still bounded to a known set rather than
// arbitrary free-text keys.
// ---------------------------------------------------------------------------

export const PREFERENCE_FIELDS = [
  "travelStyle",
  "pace",
  "hotelType",
  "timeOfDay",
  "neighborhoodVibe",
  "dateFlexibility",
] as const;

export type PreferenceFieldName = (typeof PREFERENCE_FIELDS)[number];

export const ExtractedPreference = z.object({
  field: z.enum(PREFERENCE_FIELDS),
  value: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  ...provenance,
});
export type ExtractedPreference = z.infer<typeof ExtractedPreference>;

export interface PreferenceRecord {
  id: string;
  field: PreferenceFieldName;
  value: string | string[];
  source: ExtractionSource;
  confidence: number;
  status: "active" | "retracted";
  createdAt: string;
}

export function toPreferenceRecord(
  extracted: ExtractedPreference,
  opts: { id: string; createdAt: string; status?: PreferenceRecord["status"] },
): PreferenceRecord {
  return {
    id: opts.id,
    field: extracted.field,
    value: extracted.value,
    source: extracted.source,
    confidence: extracted.confidence,
    status: opts.status ?? "active",
    createdAt: opts.createdAt,
  };
}

// ---------------------------------------------------------------------------
// request_clarification tool (PROJECT_BRIEF.md §12) — a structured request
// back to the orchestrator, not a free-text guess at what to ask.
// ---------------------------------------------------------------------------

export const ClarificationRequest = z.object({
  missingFields: z.array(z.enum(REQUIREMENT_FIELDS)).min(1),
  reason: z.string().min(1),
});
export type ClarificationRequest = z.infer<typeof ClarificationRequest>;

// ---------------------------------------------------------------------------
// propose_trip_revision tool (PROJECT_BRIEF.md §12) — still passes through
// domain validation before becoming a decision; this schema only enforces
// the tool-call shape itself, not the semantics of `value` (that happens
// wherever the revision is actually applied, out of scope for Phase 4).
// ---------------------------------------------------------------------------

export const RevisionProposal = z.object({
  revisionType: z.enum(["requirement", "preference", "decision"]),
  target: z.string().min(1),
  value: z.unknown(),
});
export type RevisionProposal = z.infer<typeof RevisionProposal>;
