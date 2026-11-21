import { expect, it } from "vitest";
import { round2 } from "../src/tax";

it("rounds to cents", () => {
  expect(round2(1.234)).toBe(1.23);
});
