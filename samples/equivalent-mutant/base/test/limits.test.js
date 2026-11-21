import { expect, it } from "vitest";
import { atMost } from "../src/limits.js";

it("caps at the maximum", () => {
  expect(atMost(9, 5)).toBe(5);
});
