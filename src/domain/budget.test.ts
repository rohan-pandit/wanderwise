import { describe, expect, it } from "vitest";
import { money } from "./money";
import { calculateBudget, type BudgetInput } from "./budget";

function baseInput(overrides: Partial<BudgetInput> = {}): BudgetInput {
  return {
    currency: "USD",
    travelers: 2,
    targetUsd: 3000,
    flights: [{ priceUsd: 500, taxesFeesUsd: 80 }],
    hotel: { pricePerNightUsd: 150, taxesFeesUsd: 20, nights: 5 },
    activities: [{ id: "act-1", priceUsd: 89, partySize: 2 }],
    contingencyRate: 0,
    ...overrides,
  };
}

describe("calculateBudget", () => {
  it("multiplies flight price and taxes by traveler count", () => {
    const result = calculateBudget(baseInput({ hotel: undefined, activities: [] }));
    // 500 * 2 travelers = 1000 subtotal, 80 * 2 = 160 taxes
    expect(result.subtotal).toEqual(money(1000));
    expect(result.taxesAndFees).toEqual(money(160));
    expect(result.totalEstimate).toEqual(money(1160));
  });

  it("multiplies hotel rate by nights but not by travelers, and keeps hotel taxes flat", () => {
    const result = calculateBudget(baseInput({ flights: [], activities: [] }));
    // 150/night * 5 nights = 750; taxes flat at 20
    expect(result.subtotal).toEqual(money(750));
    expect(result.taxesAndFees).toEqual(money(20));
  });

  it("prices activities by their own party size when given, else by travelers", () => {
    const result = calculateBudget(
      baseInput({
        flights: [],
        hotel: undefined,
        activities: [
          { id: "solo", priceUsd: 40 }, // defaults to travelers (2)
          { id: "one-person", priceUsd: 40, partySize: 1 },
        ],
      }),
    );
    expect(result.subtotal).toEqual(money(40 * 2 + 40 * 1));
  });

  it("excludes unpriced activities from the subtotal and reports them", () => {
    const result = calculateBudget(
      baseInput({
        flights: [],
        hotel: undefined,
        activities: [{ id: "act-1", priceUsd: 50, partySize: 1 }, { id: "mystery-tour" }],
      }),
    );
    expect(result.subtotal).toEqual(money(50));
    expect(result.unpricedItems).toEqual(["mystery-tour"]);
  });

  it("computes contingency as a rate on subtotal plus taxes", () => {
    const result = calculateBudget(
      baseInput({
        flights: [],
        hotel: undefined,
        activities: [{ id: "act-1", priceUsd: 100, partySize: 1 }],
        contingencyRate: 0.1,
      }),
    );
    expect(result.contingency).toEqual(money(10));
    expect(result.totalEstimate).toEqual(money(110));
  });

  it("defaults the ceiling to the target when not given", () => {
    const result = calculateBudget(baseInput({ targetUsd: 500, ceilingUsd: undefined, flights: [], hotel: undefined, activities: [] }));
    expect(result.ceiling).toEqual(money(500));
  });

  it("flags a ceiling violation with the exact overage, and none when within budget", () => {
    const over = calculateBudget(
      baseInput({
        ceilingUsd: 1000,
        flights: [],
        hotel: undefined,
        activities: [{ id: "act-1", priceUsd: 1200, partySize: 1 }],
      }),
    );
    expect(over.violations).toEqual([
      {
        code: "CEILING_EXCEEDED",
        message: "Estimated total $1,200.00 exceeds the $1,000.00 ceiling by $200.00.",
        amountOver: money(200),
      },
    ]);
    expect(over.remaining).toEqual(money(-200));

    const within = calculateBudget(
      baseInput({
        ceilingUsd: 1000,
        flights: [],
        hotel: undefined,
        activities: [{ id: "act-1", priceUsd: 800, partySize: 1 }],
      }),
    );
    expect(within.violations).toEqual([]);
    expect(within.remaining).toEqual(money(200));
  });

  it("supports a currency other than USD end to end", () => {
    const result = calculateBudget(
      baseInput({
        currency: "EUR",
        flights: [{ priceUsd: 100, taxesFeesUsd: 10 }],
        hotel: undefined,
        activities: [],
      }),
    );
    expect(result.subtotal).toEqual(money(200, "EUR"));
    expect(result.totalEstimate.currency).toBe("EUR");
  });
});
