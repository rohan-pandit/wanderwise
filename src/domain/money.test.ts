import { describe, expect, it } from "vitest";
import {
  addMoney,
  CurrencyMismatchError,
  formatMoney,
  isMoneyGreaterThan,
  money,
  multiplyMoney,
  sumMoney,
} from "./money";

describe("money", () => {
  it("adds two amounts in the same currency", () => {
    expect(addMoney(money(10), money(5))).toEqual(money(15));
  });

  it("rounds to 2 decimal places", () => {
    expect(addMoney(money(0.1), money(0.2))).toEqual(money(0.3));
  });

  it("throws on mismatched currencies", () => {
    expect(() => addMoney(money(10, "USD"), money(10, "EUR"))).toThrow(
      CurrencyMismatchError,
    );
  });

  it("sums a list of amounts", () => {
    expect(sumMoney([money(10), money(20), money(30)])).toEqual(money(60));
  });

  it("sums an empty list to zero", () => {
    expect(sumMoney([])).toEqual(money(0));
  });

  it("multiplies by a factor (e.g. nights x rate)", () => {
    expect(multiplyMoney(money(100), 3)).toEqual(money(300));
  });

  it("compares amounts in the same currency", () => {
    expect(isMoneyGreaterThan(money(100), money(50))).toBe(true);
    expect(isMoneyGreaterThan(money(50), money(100))).toBe(false);
  });

  it("throws comparing mismatched currencies", () => {
    expect(() => isMoneyGreaterThan(money(10, "USD"), money(10, "EUR"))).toThrow(
      CurrencyMismatchError,
    );
  });

  it("formats as currency", () => {
    expect(formatMoney(money(1234.5))).toBe("$1,234.50");
  });
});
