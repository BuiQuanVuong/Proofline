import { expect, it } from "vitest";
import { atLeast, atMost } from "../src/limits.js";

it("caps at the maximum", () => {
  expect(atMost(9, 5)).toBe(5);
});

it("raises values below the minimum", () => {
  expect(atLeast(1, 3)).toBe(3);
});

it("keeps values at or above the minimum", () => {
  expect(atLeast(3, 3)).toBe(3);
  expect(atLeast(5, 3)).toBe(5);
});
