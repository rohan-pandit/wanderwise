/**
 * Room-configuration vocabulary (PROJECT_BRIEF.md §9.3/§9.5's "party-size
 * requirements" and "per-person calculations", generalized to a party that
 * splits across more than one room — e.g. parents in one room, kids in
 * another, or a group of friends wanting their own room). There is no
 * traveler-identity concept anywhere else in the domain model, so a room
 * group is just an occupant count, plus an optional label for explanation
 * surfaces later ("kids", "friends") — never a list of named people.
 */
export interface RoomGroup {
  /** People staying in this one room. */
  occupants: number;
  /** Not used in any calculation — only for explaining the itinerary back to the user. */
  label?: string;
}

export class RoomConfigurationError extends Error {
  constructor(totalOccupantsCount: number, travelers: number) {
    super(
      `Room groups add up to ${totalOccupantsCount} occupant(s), but the party has ${travelers} traveler(s).`,
    );
    this.name = "RoomConfigurationError";
  }
}

export function totalOccupants(roomGroups: RoomGroup[]): number {
  return roomGroups.reduce((sum, g) => sum + g.occupants, 0);
}

export function maxRoomOccupancy(roomGroups: RoomGroup[]): number {
  return Math.max(...roomGroups.map((g) => g.occupants));
}

/** Throws `RoomConfigurationError` if the room groups don't account for every traveler. */
export function assertRoomGroupsMatchTravelers(roomGroups: RoomGroup[], travelers: number): void {
  const total = totalOccupants(roomGroups);
  if (total !== travelers) {
    throw new RoomConfigurationError(total, travelers);
  }
}
