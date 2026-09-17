/**
 * Component eval cases for retrieval quality (PROJECT_BRIEF.md §10.3:
 * relevant-item recall, top-k precision, destination/tag filtering
 * accuracy). Deterministic assertions against known seed data
 * (`supabase/migrations/0002_seed_data.sql`) — no LLM grading.
 */
import type { MatchedActivity } from "@/src/repositories/activities";
import type { MatchedDestination } from "@/src/repositories/destinations";

export interface EvalAssertion {
  pass: boolean;
  detail: string;
}

export interface DestinationRetrievalCase {
  name: string;
  description: string;
  query: string;
  maxDailyCostUsd?: number;
  vibeTags?: string[];
  topK: number;
  assert: (results: MatchedDestination[]) => EvalAssertion[];
}

export interface ActivityRetrievalCase {
  name: string;
  description: string;
  destination: string;
  query: string;
  excludeClosedOnDays?: string[];
  accessibilityNeeds?: string[];
  topK: number;
  assert: (results: MatchedActivity[]) => EvalAssertion[];
}

function topName(results: { name: string }[]): string | undefined {
  return results[0]?.name;
}

export const DESTINATION_RETRIEVAL_CASES: DestinationRetrievalCase[] = [
  {
    name: "kyoto_temples_and_seasonal_cooking",
    description: "Query strongly matches Kyoto's seed description (temples/shrines/seasonal cooking).",
    query: "thousands of temples and shrines, plus some of the best seasonal Japanese cooking",
    topK: 3,
    assert: (results) => [{ pass: topName(results) === "Kyoto", detail: `top result was "${topName(results)}" (want "Kyoto")` }],
  },
  {
    name: "reykjavik_glaciers_and_aurora",
    description: "Query strongly matches Reykjavik's seed description (glaciers/geothermal/aurora).",
    query: "glaciers, geothermal hot springs, and chasing the northern lights",
    topK: 3,
    assert: (results) => [{ pass: topName(results) === "Reykjavik", detail: `top result was "${topName(results)}" (want "Reykjavik")` }],
  },
  {
    name: "tulum_ruins_and_cenotes",
    description: "Query strongly matches Tulum's seed description (Mayan ruins/cenotes/Caribbean beach).",
    query: "cliffside Mayan ruins and cenote snorkeling on a laid-back Caribbean coast",
    topK: 3,
    assert: (results) => [{ pass: topName(results) === "Tulum", detail: `top result was "${topName(results)}" (want "Tulum")` }],
  },
  {
    name: "budget_filter_excludes_pricier_semantic_matches",
    description: "A tight daily-cost ceiling should exclude Reykjavik/Kyoto/Tulum/Barcelona/Lisbon even for a broadly-matching query, leaving only Cape Town ($110/day).",
    query: "a great destination with good food and outdoor activities",
    maxDailyCostUsd: 115,
    topK: 6,
    assert: (results) => [
      { pass: results.every((d) => (d.estimated_daily_cost_usd ?? 0) <= 115), detail: "every result respects the $115/day ceiling" },
      { pass: results.some((d) => d.name === "Cape Town"), detail: "Cape Town ($110/day) is included" },
      { pass: !results.some((d) => d.name === "Reykjavik"), detail: "Reykjavik ($180/day) is excluded despite outdoor-activity relevance" },
    ],
  },
  {
    name: "vibe_tag_filter_is_a_hard_prefilter",
    description: "vibeTags=['wine'] should hard-filter to only Cape Town, the one destination tagged 'wine', regardless of semantic ranking.",
    query: "a relaxing getaway",
    vibeTags: ["wine"],
    topK: 6,
    assert: (results) => [
      { pass: results.length === 1 && results[0]?.name === "Cape Town", detail: `results were [${results.map((d) => d.name).join(", ")}], want only Cape Town` },
    ],
  },
];

export const ACTIVITY_RETRIEVAL_CASES: ActivityRetrievalCase[] = [
  {
    name: "kyoto_tea_ceremony",
    description: "Query strongly matches the Tea Ceremony Experience's seed description.",
    destination: "Kyoto",
    query: "hands-on Japanese tea ceremony with a certified tea master in a traditional house",
    topK: 3,
    assert: (results) => [{ pass: topName(results) === "Tea Ceremony Experience", detail: `top result was "${topName(results)}"` }],
  },
  {
    name: "reykjavik_northern_lights",
    description: "Query strongly matches the Northern Lights Hunt's seed description.",
    destination: "Reykjavik",
    query: "evening minibus tour chasing clear skies for a chance at the aurora",
    topK: 3,
    assert: (results) => [{ pass: topName(results) === "Northern Lights Hunt", detail: `top result was "${topName(results)}"` }],
  },
  {
    name: "closed_day_filter_excludes_the_best_semantic_match",
    description: "Fado Dinner Show is closed Sun/Mon/Tue and is the best semantic match for this query — excluding Monday should filter it out entirely.",
    destination: "Lisbon",
    query: "a traditional fado music performance with dinner",
    excludeClosedOnDays: ["monday"],
    topK: 3,
    assert: (results) => [
      { pass: !results.some((a) => a.name === "Fado Dinner Show"), detail: "Fado Dinner Show (closed Mondays) is excluded" },
    ],
  },
  {
    name: "closed_day_filter_is_a_noop_when_the_activity_is_open",
    description: "Sanity check: the same query without the Monday exclusion should surface Fado Dinner Show, proving the previous case's exclusion actually did something.",
    destination: "Lisbon",
    query: "a traditional fado music performance with dinner",
    topK: 3,
    assert: (results) => [
      { pass: results.some((a) => a.name === "Fado Dinner Show"), detail: "Fado Dinner Show appears when no closed-day filter is applied" },
    ],
  },
  {
    name: "accessibility_filter",
    description: "Cape Town: only Table Mountain Cableway and Boulders Beach Penguin Colony are tagged wheelchair-accessible.",
    destination: "Cape Town",
    query: "a scenic outdoor activity",
    accessibilityNeeds: ["wheelchair-accessible"],
    topK: 6,
    assert: (results) => [
      { pass: results.length > 0, detail: "at least one accessible activity returned" },
      {
        pass: results.every((a) => (a.accessibility_attributes ?? []).includes("wheelchair-accessible")),
        detail: "every result is tagged wheelchair-accessible",
      },
      { pass: !results.some((a) => a.name === "Constantia Winelands Tasting Tour"), detail: "the non-accessible winelands tour is excluded" },
    ],
  },
];
