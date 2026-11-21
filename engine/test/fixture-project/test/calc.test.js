import { expect, it } from "vitest";
import { add, clamp, isAdult } from "../src/calc.js";

it("adds", () => {
  expect(add(2, 3)).toBe(5);
});

it("clamps the middle", () => {
  expect(clamp(5, 0, 10)).toBe(5);
});

it("clamps low values", () => {
  expect(clamp(-5, 0, 10)).toBe(0);
});

it("detects adults", () => {
  expect(isAdult(30)).toBe(true);
  expect(isAdult(3)).toBe(false);
});
