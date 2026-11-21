import { expect, it } from "vitest";
import { discount, shipping } from "../src/pricing.js";

it("charges $2 per kg", () => {
  expect(shipping(3)).toBe(6);
});

it("leaves small orders alone", () => {
  expect(discount(50)).toBe(50);
});

it("takes 10% off large orders", () => {
  expect(discount(200)).toBeCloseTo(180);
});
