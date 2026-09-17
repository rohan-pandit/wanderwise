import { describe, expect, it } from "vitest";
import { activity, flight, hotel } from "@/src/repositories/fixtures";
import { assembleCandidateCombinations, type CombinationParams } from "./combinations";
import { money } from "./money";

function baseParams(overrides: Partial<CombinationParams> = {}): CombinationParams {
  return {
    outboundFlights: [flight()],
    hotels: [hotel()],
    activities: [],
    travelers: 2,
    roomGroups: [{ occupants: 2 }],
    nights: 5,
    targetUsd: 3000,
    ...overrides,
  };
}

describe("assembleCandidateCombinations", () => {
  it("cross-joins every outbound flight/hotel pair (one-way, no returnFlights given)", () => {
    const params = baseParams({
      outboundFlights: [flight({ id: "f1" }), flight({ id: "f2" })],
      hotels: [hotel({ id: "h1" }), hotel({ id: "h2" })],
    });
    const combos = assembleCandidateCombinations(params);
    expect(combos).toHaveLength(4);
    expect(combos.every((c) => c.returnFlight === null)).toBe(true);
  });

  it("cross-joins outbound x return x hotel when returnFlights are given", () => {
    const params = baseParams({
      outboundFlights: [flight({ id: "out1" }), flight({ id: "out2" })],
      returnFlights: [flight({ id: "ret1" }), flight({ id: "ret2" })],
      hotels: [hotel({ id: "h1" })],
      targetUsd: 100_000,
    });
    const combos = assembleCandidateCombinations(params);
    expect(combos).toHaveLength(4);
    expect(new Set(combos.map((c) => c.returnFlight?.id))).toEqual(new Set(["ret1", "ret2"]));
  });

  it("sums both legs' cost into the budget when a return flight is selected", () => {
    const params = baseParams({
      outboundFlights: [flight({ price_usd: 100, taxes_fees_usd: 10 })],
      returnFlights: [flight({ price_usd: 150, taxes_fees_usd: 20 })],
      hotels: [hotel({ price_per_night_usd: 0, taxes_fees_usd: 0 })],
      nights: 1,
      travelers: 1,
      roomGroups: [{ occupants: 1 }],
      targetUsd: 100_000,
    });
    const [combo] = assembleCandidateCombinations(params);
    // (100 + 150) * 1 traveler = 250 subtotal; (10 + 20) * 1 = 30 taxes
    expect(combo.budget.subtotal).toEqual(money(250));
    expect(combo.budget.taxesAndFees).toEqual(money(30));
  });

  it("drops a flight/hotel pair that exceeds the ceiling even with zero activities", () => {
    const params = baseParams({
      outboundFlights: [flight({ price_usd: 5000 })],
      ceilingUsd: 1000,
    });
    expect(assembleCandidateCombinations(params)).toEqual([]);
  });

  it("greedily fills in the cheapest activities that still fit under the ceiling", () => {
    const params = baseParams({
      outboundFlights: [flight({ price_usd: 100, taxes_fees_usd: 0 })],
      hotels: [hotel({ price_per_night_usd: 100, taxes_fees_usd: 0, id: "h1" })],
      nights: 1,
      travelers: 1,
      roomGroups: [{ occupants: 1 }],
      targetUsd: 400,
      ceilingUsd: 400,
      activities: [
        activity({ id: "cheap", price_usd: 50 }),
        activity({ id: "mid", price_usd: 100 }),
        activity({ id: "expensive", price_usd: 500 }),
      ],
    });
    const [combo] = assembleCandidateCombinations(params);
    // base cost 200; cheap (250) and mid (350) fit, expensive (850) doesn't
    expect(combo.activities.map((a) => a.id)).toEqual(["cheap", "mid"]);
    expect(combo.budget.violations).toEqual([]);
  });

  it("caps the number of activities included per combination", () => {
    const params = baseParams({
      outboundFlights: [flight({ price_usd: 0, taxes_fees_usd: 0 })],
      hotels: [hotel({ price_per_night_usd: 0, taxes_fees_usd: 0 })],
      nights: 1,
      targetUsd: 100_000,
      activities: Array.from({ length: 10 }, (_, i) => activity({ id: `a${i}`, price_usd: 1 })),
      maxActivities: 3,
    });
    const [combo] = assembleCandidateCombinations(params);
    expect(combo.activities).toHaveLength(3);
  });

  it("ranks combinations by activity count first, then by lowest total cost", () => {
    const params = baseParams({
      outboundFlights: [flight({ id: "f1", price_usd: 100, taxes_fees_usd: 0 })],
      hotels: [hotel({ id: "cheap-hotel", price_per_night_usd: 50, taxes_fees_usd: 0 }), hotel({ id: "pricier-hotel", price_per_night_usd: 200, taxes_fees_usd: 0 })],
      nights: 1,
      travelers: 1,
      roomGroups: [{ occupants: 1 }],
      targetUsd: 500,
      ceilingUsd: 500,
      activities: [activity({ id: "act", price_usd: 50 })],
    });
    const combos = assembleCandidateCombinations(params);
    // Both hotels leave room for the one activity, so both combos include it;
    // the cheaper hotel combo should sort first on total cost.
    expect(combos[0].hotel.id).toBe("cheap-hotel");
    expect(combos.every((c) => c.activities.length === 1)).toBe(true);
  });

  it("returns an empty list when no flight/hotel pair fits", () => {
    const params = baseParams({ ceilingUsd: 1 });
    expect(assembleCandidateCombinations(params)).toEqual([]);
  });

  it("books and costs one room per room group (parents and kids in separate rooms)", () => {
    const params = baseParams({
      outboundFlights: [flight({ price_usd: 0, taxes_fees_usd: 0 })],
      hotels: [hotel({ price_per_night_usd: 100, taxes_fees_usd: 10, room_capacity: 2 })],
      nights: 2,
      travelers: 4,
      roomGroups: [
        { occupants: 2, label: "parents" },
        { occupants: 2, label: "kids" },
      ],
      targetUsd: 100_000,
    });
    const [combo] = assembleCandidateCombinations(params);
    expect(combo.rooms).toBe(2);
    // 100/night * 2 nights * 2 rooms = 400; taxes 10 * 2 rooms = 20
    expect(combo.budget.subtotal).toEqual(money(400));
    expect(combo.budget.taxesAndFees).toEqual(money(20));
  });

  it("only requires the hotel to fit the largest room group, not the whole party (parents/kids/friends splitting three rooms)", () => {
    const params = baseParams({
      outboundFlights: [flight({ price_usd: 0, taxes_fees_usd: 0 })],
      hotels: [hotel({ room_capacity: 3 })],
      travelers: 7,
      roomGroups: [
        { occupants: 2, label: "parents" },
        { occupants: 2, label: "kids" },
        { occupants: 3, label: "friends" },
      ],
      targetUsd: 100_000,
    });
    const [combo] = assembleCandidateCombinations(params);
    expect(combo.rooms).toBe(3);
  });

  it("skips a hotel whose room capacity can't fit the largest room group", () => {
    const params = baseParams({
      hotels: [hotel({ room_capacity: 1 })], // too small for either 2-occupant group below
      travelers: 4,
      roomGroups: [
        { occupants: 2, label: "parents" },
        { occupants: 2, label: "kids" },
      ],
    });
    expect(assembleCandidateCombinations(params)).toEqual([]);
  });

  it("throws when room groups don't add up to the traveler count", () => {
    const params = baseParams({ travelers: 4, roomGroups: [{ occupants: 2 }] });
    expect(() => assembleCandidateCombinations(params)).toThrow(
      "Room groups add up to 2 occupant(s), but the party has 4 traveler(s).",
    );
  });
});
