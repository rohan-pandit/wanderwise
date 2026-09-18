import { describe, expect, it } from "vitest";
import { activity, flight, hotel } from "@/src/repositories/fixtures";
import {
  categoryConstraint,
  excludeClosedOnDaysConstraint,
  filterHardConstraints,
  maxActivityPriceConstraint,
  maxFlightPriceConstraint,
  maxHotelPriceConstraint,
  minHotelRatingConstraint,
  noRedEyeConstraint,
  refundableConstraint,
  requiredAccessibilityConstraint,
  roomAvailabilityConstraint,
  roomCapacityConstraint,
} from "./constraints";

describe("filterHardConstraints", () => {
  it("passes candidates that satisfy every constraint", () => {
    const flights = [flight({ id: "a" }), flight({ id: "b", is_red_eye: true })];
    const result = filterHardConstraints(flights, [noRedEyeConstraint()]);
    expect(result.passing.map((f) => f.id)).toEqual(["a"]);
    expect(result.rejected).toEqual([
      { candidate: flights[1], code: "NO_RED_EYE", reason: "Red-eye flights are excluded." },
    ]);
  });

  it("rejects on the first failing constraint, not every failing one", () => {
    const cheapButRedEye = flight({ id: "c", is_red_eye: true, price_usd: 9999 });
    const result = filterHardConstraints(
      [cheapButRedEye],
      [noRedEyeConstraint(), maxFlightPriceConstraint(500)],
    );
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].code).toBe("NO_RED_EYE");
  });

  it("passes everything when there are no constraints", () => {
    const flights = [flight(), flight({ id: "b" })];
    expect(filterHardConstraints(flights, []).passing).toEqual(flights);
  });
});

describe("flight constraints", () => {
  it("enforces a maximum price", () => {
    const constraint = maxFlightPriceConstraint(400);
    expect(constraint.isSatisfiedBy(flight({ price_usd: 400 }))).toBe(true);
    expect(constraint.isSatisfiedBy(flight({ price_usd: 401 }))).toBe(false);
  });
});

describe("hotel constraints", () => {
  it("enforces a minimum rating, treating a missing rating as 0", () => {
    const constraint = minHotelRatingConstraint(4);
    expect(constraint.isSatisfiedBy(hotel({ rating: 4 }))).toBe(true);
    expect(constraint.isSatisfiedBy(hotel({ rating: 3.9 }))).toBe(false);
    expect(constraint.isSatisfiedBy(hotel({ rating: null }))).toBe(false);
  });

  it("enforces room capacity against a single room group", () => {
    const constraint = roomCapacityConstraint([{ occupants: 3 }]);
    expect(constraint.isSatisfiedBy(hotel({ room_capacity: 3 }))).toBe(true);
    expect(constraint.isSatisfiedBy(hotel({ room_capacity: 2 }))).toBe(false);
  });

  it("enforces room capacity against the largest of several room groups (parents/kids/friends splitting rooms)", () => {
    const constraint = roomCapacityConstraint([
      { occupants: 2, label: "parents" },
      { occupants: 2, label: "kids" },
      { occupants: 3, label: "friends" },
    ]);
    // The hotel books one room per group, so it only needs to fit the
    // largest group (3), not the whole party (7).
    expect(constraint.isSatisfiedBy(hotel({ room_capacity: 3 }))).toBe(true);
    expect(constraint.isSatisfiedBy(hotel({ room_capacity: 2 }))).toBe(false);
  });

  it("enforces enough rooms available for one room group each", () => {
    const constraint = roomAvailabilityConstraint([
      { occupants: 2, label: "parents" },
      { occupants: 1, label: "kid" },
    ]);
    expect(constraint.isSatisfiedBy(hotel({ available_rooms: 2 }))).toBe(true);
    expect(constraint.isSatisfiedBy(hotel({ available_rooms: 1 }))).toBe(false);
  });

  it("enforces a maximum price per night", () => {
    const constraint = maxHotelPriceConstraint(150);
    expect(constraint.isSatisfiedBy(hotel({ price_per_night_usd: 150 }))).toBe(true);
    expect(constraint.isSatisfiedBy(hotel({ price_per_night_usd: 151 }))).toBe(false);
  });

  it("enforces refundability against real free-text cancellation policies", () => {
    const constraint = refundableConstraint();
    expect(
      constraint.isSatisfiedBy(
        hotel({ cancellation_policy: "Free cancellation up to 48 hours before check-in" }),
      ),
    ).toBe(true);
    expect(constraint.isSatisfiedBy(hotel({ cancellation_policy: "Non-refundable" }))).toBe(false);
    expect(constraint.isSatisfiedBy(hotel({ cancellation_policy: null }))).toBe(false);
  });
});

describe("activity constraints", () => {
  it("enforces required accessibility attributes", () => {
    const constraint = requiredAccessibilityConstraint(["wheelchair-accessible"]);
    expect(
      constraint.isSatisfiedBy(activity({ accessibility_attributes: ["wheelchair-accessible"] })),
    ).toBe(true);
    expect(
      constraint.isSatisfiedBy(activity({ accessibility_attributes: ["wheelchair-limited"] })),
    ).toBe(false);
    expect(constraint.isSatisfiedBy(activity({ accessibility_attributes: null }))).toBe(false);
  });

  it("excludes activities closed on required days, case-insensitively", () => {
    const constraint = excludeClosedOnDaysConstraint(["Monday"]);
    expect(constraint.isSatisfiedBy(activity({ closed_days: ["monday"] }))).toBe(false);
    expect(constraint.isSatisfiedBy(activity({ closed_days: ["tuesday"] }))).toBe(true);
    expect(constraint.isSatisfiedBy(activity({ closed_days: null }))).toBe(true);
  });

  it("restricts activities to a chosen set of categories, case-insensitively", () => {
    const constraint = categoryConstraint(["Food", "spa"]);
    expect(constraint.isSatisfiedBy(activity({ category: "food" }))).toBe(true);
    expect(constraint.isSatisfiedBy(activity({ category: "spa" }))).toBe(true);
    expect(constraint.isSatisfiedBy(activity({ category: "nightlife" }))).toBe(false);
    expect(constraint.isSatisfiedBy(activity({ category: null }))).toBe(false);
  });

  it("enforces a maximum activity price", () => {
    const constraint = maxActivityPriceConstraint(50);
    expect(constraint.isSatisfiedBy(activity({ price_usd: 50 }))).toBe(true);
    expect(constraint.isSatisfiedBy(activity({ price_usd: 51 }))).toBe(false);
  });
});
