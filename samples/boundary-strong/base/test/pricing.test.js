import { expect, it } from "vitest";
import { shipping } from "../src/pricing.js";

it("charges $2 per kg", () => {
  expect(shipping(3)).toBe(6);
});
