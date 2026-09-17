import { describe, expect, it } from "vitest";
import { REQUIREMENT_FIELDS, type RequirementFieldName } from "./extraction";
import {
  CHAIN_STEPS,
  REQUIREMENT_FIELD_STEP,
  getCurrentChainStep,
  invalidatedStepsForActivitiesChange,
  invalidatedStepsForFlightChange,
  invalidatedStepsForHotelChange,
  invalidatedStepsForRequirementField,
  requirementRevisionTargetStep,
  revisionRisksConfirmedWork,
} from "./chain";

describe("REQUIREMENT_FIELD_STEP", () => {
  it("classifies every RequirementFieldName — none left unmapped", () => {
    for (const field of REQUIREMENT_FIELDS) {
      expect(REQUIREMENT_FIELD_STEP[field]).toBeDefined();
    }
  });

  it("marks the fields every step depends on as foundational", () => {
    const foundational: RequirementFieldName[] = [
      "origin",
      "destination",
      "departureDate",
      "returnDate",
      "partySize",
      "roomGroups",
      "budgetTotalUsd",
    ];
    for (const field of foundational) {
      expect(REQUIREMENT_FIELD_STEP[field]).toBe("foundational");
    }
  });

  it("classifies flight/hotel/activities-specific fields to their own step", () => {
    expect(REQUIREMENT_FIELD_STEP.noRedEye).toBe("flight");
    expect(REQUIREMENT_FIELD_STEP.maxFlightPriceUsd).toBe("flight");
    expect(REQUIREMENT_FIELD_STEP.minHotelRating).toBe("hotel");
    expect(REQUIREMENT_FIELD_STEP.maxHotelPriceUsd).toBe("hotel");
    expect(REQUIREMENT_FIELD_STEP.refundableHotel).toBe("hotel");
    expect(REQUIREMENT_FIELD_STEP.requiredAccessibility).toBe("activities");
    expect(REQUIREMENT_FIELD_STEP.excludeClosedOnDays).toBe("activities");
    expect(REQUIREMENT_FIELD_STEP.maxActivityPriceUsd).toBe("activities");
  });
});

describe("getCurrentChainStep", () => {
  it("is 'flight' when nothing is confirmed yet", () => {
    expect(getCurrentChainStep([])).toBe("flight");
  });

  it("stays on 'flight' until both outboundFlight and returnFlight are confirmed", () => {
    expect(getCurrentChainStep([{ field: "outboundFlight", status: "confirmed" }])).toBe("flight");
  });

  it("advances to 'hotel' once both flight decisions are confirmed", () => {
    expect(
      getCurrentChainStep([
        { field: "outboundFlight", status: "confirmed" },
        { field: "returnFlight", status: "confirmed" },
      ]),
    ).toBe("hotel");
  });

  it("advances to 'activities' once flight and hotel are confirmed", () => {
    expect(
      getCurrentChainStep([
        { field: "outboundFlight", status: "confirmed" },
        { field: "returnFlight", status: "confirmed" },
        { field: "hotel", status: "confirmed" },
      ]),
    ).toBe("activities");
  });

  it("is 'complete' once every step's decisions are confirmed", () => {
    expect(
      getCurrentChainStep([
        { field: "outboundFlight", status: "confirmed" },
        { field: "returnFlight", status: "confirmed" },
        { field: "hotel", status: "confirmed" },
        { field: "activities", status: "confirmed" },
      ]),
    ).toBe("complete");
  });

  it("doesn't count a merely-'proposed' decision as confirmed", () => {
    expect(
      getCurrentChainStep([
        { field: "outboundFlight", status: "proposed" },
        { field: "returnFlight", status: "proposed" },
      ]),
    ).toBe("flight");
  });

  it("ignores a superseded decision even if a later row for the same field is confirmed", () => {
    expect(
      getCurrentChainStep([
        { field: "outboundFlight", status: "superseded" },
        { field: "outboundFlight", status: "confirmed" },
        { field: "returnFlight", status: "confirmed" },
      ]),
    ).toBe("hotel");
  });
});

describe("invalidatedStepsForRequirementField", () => {
  it("invalidates the whole chain for a foundational field", () => {
    expect(invalidatedStepsForRequirementField("destination")).toEqual([...CHAIN_STEPS]);
    expect(invalidatedStepsForRequirementField("budgetTotalUsd")).toEqual([...CHAIN_STEPS]);
  });

  it("invalidates from 'flight' onward for a flight-specific field", () => {
    expect(invalidatedStepsForRequirementField("maxFlightPriceUsd")).toEqual(["flight", "hotel", "activities"]);
  });

  it("invalidates from 'hotel' onward for a hotel-specific field", () => {
    expect(invalidatedStepsForRequirementField("minHotelRating")).toEqual(["hotel", "activities"]);
  });

  it("invalidates only 'activities' for an activities-specific field", () => {
    expect(invalidatedStepsForRequirementField("maxActivityPriceUsd")).toEqual(["activities"]);
  });
});

describe("invalidatedStepsForFlightChange", () => {
  it("invalidates the whole downstream chain when the derived stay dates changed", () => {
    expect(invalidatedStepsForFlightChange(true)).toEqual(["flight", "hotel", "activities"]);
  });

  it("invalidates only the flight step itself when the stay dates are unchanged", () => {
    expect(invalidatedStepsForFlightChange(false)).toEqual(["flight"]);
  });
});

describe("invalidatedStepsForHotelChange", () => {
  it("never invalidates activities", () => {
    expect(invalidatedStepsForHotelChange()).toEqual(["hotel"]);
  });
});

describe("invalidatedStepsForActivitiesChange", () => {
  it("invalidates nothing downstream — it's the last step", () => {
    expect(invalidatedStepsForActivitiesChange()).toEqual(["activities"]);
  });
});

describe("requirementRevisionTargetStep", () => {
  it("routes a foundational field to 'flight'", () => {
    expect(requirementRevisionTargetStep("destination")).toBe("flight");
    expect(requirementRevisionTargetStep("budgetTotalUsd")).toBe("flight");
  });

  it("routes a step-specific field to its own step", () => {
    expect(requirementRevisionTargetStep("maxFlightPriceUsd")).toBe("flight");
    expect(requirementRevisionTargetStep("maxHotelPriceUsd")).toBe("hotel");
    expect(requirementRevisionTargetStep("maxActivityPriceUsd")).toBe("activities");
  });
});

describe("revisionRisksConfirmedWork", () => {
  it("is false for the active step when nothing downstream is confirmed", () => {
    expect(revisionRisksConfirmedWork("flight", [])).toBe(false);
  });

  it("is false when only the target step itself is confirmed", () => {
    const decisions = [
      { field: "outboundFlight", status: "confirmed" },
      { field: "returnFlight", status: "confirmed" },
    ];
    expect(revisionRisksConfirmedWork("flight", decisions)).toBe(false);
  });

  it("is true when a downstream step already has a confirmed decision", () => {
    const decisions = [
      { field: "outboundFlight", status: "confirmed" },
      { field: "returnFlight", status: "confirmed" },
      { field: "hotel", status: "confirmed" },
    ];
    expect(revisionRisksConfirmedWork("flight", decisions)).toBe(true);
    expect(revisionRisksConfirmedWork("hotel", decisions)).toBe(false);
  });

  it("ignores a merely-proposed downstream decision", () => {
    const decisions = [
      { field: "outboundFlight", status: "confirmed" },
      { field: "returnFlight", status: "confirmed" },
      { field: "hotel", status: "proposed" },
    ];
    expect(revisionRisksConfirmedWork("flight", decisions)).toBe(false);
  });
});
