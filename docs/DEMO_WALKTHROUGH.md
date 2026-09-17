# Demo Walkthrough Script

A recording script for the Phase 9 portfolio demo. Not a transcript to read verbatim — a beat sheet so the recording covers every narrative point `PROJECT_BRIEF.md` §21 asks for, in an order that flows as a real product demo rather than a feature checklist.

**Before recording:** decide whether any real (not synthetic) data would be uncomfortable to show on `/internal/analytics` or `/internal/product-metrics` — see the telemetry retention note in [ADR-007](architecture/ADR-007-observability.md). If everything in the database is your own test/eval data (true as of Phase 9), there's nothing to redact.

Target length: 5-8 minutes. Screen recording + voiceover, or captions — whichever you're set up for.

---

## 1. Open — positioning (30s)

Show the landing page. Say what this is and what it deliberately isn't, in your own words — the anchor line:

> "A travel-planning concierge that uses AI to interpret and curate, over a deterministic engine that owns feasibility, budget, and correctness. It's not a booking platform, and it's not 'the LLM handles everything.'"

Sign in via magic link (or narrate that step quickly if you've pre-authenticated to save time).

## 2. The golden path — plan a real trip (2-3 min)

Type something with real ambiguity in it, not a perfectly-structured request — this is the moment that shows the Intake agent doing actual interpretation, not just field extraction:

> "I want to take my partner somewhere warm and relaxing in October, nothing too expensive, maybe $3000 total."

Narrate as it responds:
- It should ask a clarifying question (no destination/dates/party size yet) — point out this is a **deterministic completeness check** (`checkRequirementsComplete`), not the model deciding it's done.
- Answer with specifics (destination, dates, party size).
- Once requirements are ready, the flight step proposes real seeded candidates — click one.
- Hotel step proposes candidates — click one.
- Activities step proposes a schedule — click "Confirm this schedule."
- The Itinerary Writer produces the final day-by-day write-up.

Call out live: **every ID in that schedule was checked against the actual retrieved candidate set before being shown** — this is the inventory-grounding guardrail, not a hope that the model didn't hallucinate.

## 3. Show a revision (1 min)

Click "Change" on the confirmed flight. Narrate: this is the "swap the hotel" / "make it cheaper" flow §3.1 calls for. If changing an earlier step risks invalidating already-confirmed later work, point out the warning banner that appears before anything is actually retired — nothing silently discards confirmed decisions.

## 4. Show an impossible constraint (1 min, optional but strong)

Start a second trip with a budget too low for any real combination (e.g., $200 total for a week abroad). Show that it reports infeasibility with the specific violated constraint, rather than quietly returning something over budget. This is the moment that most directly demonstrates "deterministic services own correctness."

## 5. Finalize (30s)

Back on the first trip, click "Finalize trip." Narrate: finalization is gated by the workflow state machine — it requires the currently-confirmed decisions to match what was actually approved, not just "the button was clicked."

## 6. Observability (1-2 min)

Switch to `/internal/analytics`:
- Point at cost/latency/cache-hit-rate by agent — mention the real measured result: **45.5% cost reduction from prompt caching, but no latency improvement** (a genuine "caching isn't automatically a speed win" finding, not assumed).
- Point at guardrail trigger frequency — this is real data from real guardrail checks, not a mocked panel.

Switch to `/internal/product-metrics`. Narrate the deliberate separation from the engineering dashboard: a high agent-call count is never supposed to read as product success (§13.4).

## 7. Evaluation suite (1 min, can be a still screenshot rather than live)

Show (or just describe) `npm run eval:scenarios` output, or the eval pass-rate trend on the analytics dashboard. Mention one concrete thing an eval actually caught: the `over_budget_request` case found that a trip could finalize over its stated budget ceiling — a real gap, tracked openly in `docs/IMPLEMENTATION_PLAN.md` §5, not hidden.

## 8. Close — what's next / what would change for real (30s)

Say, in your own words: what would need to change before this touches real providers or real money (live inventory behind the same search interface; a new, explicitly-gated boundary before any real booking/payment — see the README's ["What would change for live providers or real booking"](../README.md#what-would-change-for-live-providers-or-real-booking) section for the specifics). This is the moment that shows you know exactly where the line is, not that you forgot there was one.

---

## If you only have 2 minutes

Sections 1, 2 (abbreviated — skip the clarifying-question beat), 5, and 8. That's positioning, the golden path, finalization, and the "what's not real" close — the minimum that avoids ever implying this books real travel.
