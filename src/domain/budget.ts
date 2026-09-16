/**
 * Budget engine (PROJECT_BRIEF.md §9.3). Deterministic, reproducible, and the
 * only place totals get computed — an LLM must never calculate or rewrite a
 * total (§9.3, §8.6). Takes a structured snapshot of what's currently
 * selected and returns an itemized breakdown plus any ceiling violation.
 */
import { addMoney, formatMoney, type Money, money, multiplyMoney, round2, sumMoney } from "./money";

export interface FlightSelection {
  /** Price per traveler; multiplied by `travelers` below. */
  priceUsd: number;
  /** Taxes/fees per traveler, same as `priceUsd`; also multiplied by `travelers`. */
  taxesFeesUsd: number;
}

export interface HotelSelection {
  pricePerNightUsd: number;
  /** Taxes/fees per room for the whole stay (not per night); multiplied by `rooms`. */
  taxesFeesUsd: number;
  nights: number;
  /** Rooms booked at this rate, e.g. one per room group when the party splits across rooms. Defaults to 1. */
  rooms?: number;
}

export interface ActivitySelection {
  id: string;
  /** Price per participant. Omit when the price isn't known yet — the item
   * is then excluded from the subtotal and reported in `unpricedItems`
   * instead of silently treated as free. */
  priceUsd?: number;
  /** Defaults to `travelers` when omitted (whole party attends). */
  partySize?: number;
}

export interface BudgetInput {
  currency: string;
  travelers: number;
  /** Preferred amount. */
  targetUsd: number;
  /** Amount that cannot be exceeded without explicit user override. Defaults to `targetUsd`. */
  ceilingUsd?: number;
  flights: FlightSelection[];
  hotel?: HotelSelection;
  activities: ActivitySelection[];
  /** Flat ground-transportation estimate, if any. */
  groundTransportUsd?: number;
  /** Applied to (subtotal + taxes and fees). Defaults to 0.05. */
  contingencyRate?: number;
}

export interface BudgetViolation {
  code: "CEILING_EXCEEDED";
  message: string;
  amountOver: Money;
}

export interface BudgetBreakdown {
  target: Money;
  ceiling: Money;
  subtotal: Money;
  taxesAndFees: Money;
  contingency: Money;
  totalEstimate: Money;
  /** ceiling - totalEstimate. Negative when over the ceiling. */
  remaining: Money;
  unpricedItems: string[];
  violations: BudgetViolation[];
}

const DEFAULT_CONTINGENCY_RATE = 0.05;

export function calculateBudget(input: BudgetInput): BudgetBreakdown {
  const { currency, travelers } = input;
  const zero = money(0, currency);

  const flightSubtotal = sumMoney(
    input.flights.map((f) => multiplyMoney(money(f.priceUsd, currency), travelers)),
    currency,
  );
  const flightTaxes = sumMoney(
    input.flights.map((f) => multiplyMoney(money(f.taxesFeesUsd, currency), travelers)),
    currency,
  );

  const hotelRooms = input.hotel?.rooms ?? 1;
  const hotelSubtotal = input.hotel
    ? multiplyMoney(money(input.hotel.pricePerNightUsd, currency), input.hotel.nights * hotelRooms)
    : zero;
  const hotelTaxes = input.hotel
    ? multiplyMoney(money(input.hotel.taxesFeesUsd, currency), hotelRooms)
    : zero;

  const unpricedItems: string[] = [];
  const pricedActivities = input.activities.filter((a) => {
    if (a.priceUsd === undefined) {
      unpricedItems.push(a.id);
      return false;
    }
    return true;
  });
  const activitiesSubtotal = sumMoney(
    pricedActivities.map((a) =>
      multiplyMoney(money(a.priceUsd!, currency), a.partySize ?? travelers),
    ),
    currency,
  );

  const groundTransport = money(input.groundTransportUsd ?? 0, currency);

  const subtotal = sumMoney(
    [flightSubtotal, hotelSubtotal, activitiesSubtotal, groundTransport],
    currency,
  );
  const taxesAndFees = addMoney(flightTaxes, hotelTaxes);
  const contingencyRate = input.contingencyRate ?? DEFAULT_CONTINGENCY_RATE;
  const contingency = multiplyMoney(addMoney(subtotal, taxesAndFees), contingencyRate);
  const totalEstimate = sumMoney([subtotal, taxesAndFees, contingency], currency);

  const target = money(input.targetUsd, currency);
  const ceiling = money(input.ceilingUsd ?? input.targetUsd, currency);
  const remaining = money(round2(ceiling.amount - totalEstimate.amount), currency);

  const violations: BudgetViolation[] = [];
  if (totalEstimate.amount > ceiling.amount) {
    const amountOver = money(round2(totalEstimate.amount - ceiling.amount), currency);
    violations.push({
      code: "CEILING_EXCEEDED",
      message: `Estimated total ${formatMoney(totalEstimate)} exceeds the ${formatMoney(
        ceiling,
      )} ceiling by ${formatMoney(amountOver)}.`,
      amountOver,
    });
  }

  return {
    target,
    ceiling,
    subtotal,
    taxesAndFees,
    contingency,
    totalEstimate,
    remaining,
    unpricedItems,
    violations,
  };
}

