import { describe, expect, it } from "vitest";
import {
  assertRoomGroupsMatchTravelers,
  maxRoomOccupancy,
  RoomConfigurationError,
  totalOccupants,
} from "./rooms";

describe("rooms", () => {
  it("sums occupants across room groups", () => {
    expect(totalOccupants([{ occupants: 2 }, { occupants: 2 }])).toBe(4);
    expect(totalOccupants([])).toBe(0);
  });

  it("finds the largest single room group", () => {
    expect(
      maxRoomOccupancy([{ occupants: 2, label: "parents" }, { occupants: 3, label: "kids" }]),
    ).toBe(3);
  });

  it("accepts room groups that add up to the traveler count", () => {
    expect(() =>
      assertRoomGroupsMatchTravelers([{ occupants: 2 }, { occupants: 2 }], 4),
    ).not.toThrow();
  });

  it("rejects room groups that don't add up to the traveler count", () => {
    expect(() => assertRoomGroupsMatchTravelers([{ occupants: 2 }], 4)).toThrow(
      RoomConfigurationError,
    );
  });
});
