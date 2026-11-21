import { expect, it } from "vitest";
import { add, evaluate } from "../src/calc.js";

it("adds", () => {
  expect(add(2, 3)).toBe(5);
});

it("evaluates arithmetic", () => {
  expect(evaluate("1 + 2 * 3")).toBe(7);
});
