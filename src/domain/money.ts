/**
 * Normalized money type used throughout the domain layer. Amounts are
 * always in the currency's minor unit is NOT used here — PROJECT_BRIEF.md's
 * schema stores prices as `numeric` USD amounts (e.g. 129.50), so `amount`
 * is a plain decimal in `currency`, not cents. Keep all monetary math going
 * through these helpers rather than raw arithmetic, so currency mismatches
 * fail loudly instead of silently producing a wrong total.
 */
export interface Money {
  readonly amount: number;
  readonly currency: string;
}

export function money(amount: number, currency = "USD"): Money {
  return { amount, currency };
}

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Currency mismatch: ${a} vs ${b}`);
    this.name = "CurrencyMismatchError";
  }
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(round2(a.amount + b.amount), a.currency);
}

export function sumMoney(amounts: Money[], currency = "USD"): Money {
  return amounts.reduce((total, m) => addMoney(total, m), money(0, currency));
}

export function multiplyMoney(a: Money, factor: number): Money {
  return money(round2(a.amount * factor), a.currency);
}

export function isMoneyGreaterThan(a: Money, b: Money): boolean {
  assertSameCurrency(a, b);
  return a.amount > b.amount;
}

export function formatMoney(m: Money): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: m.currency,
  }).format(m.amount);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
