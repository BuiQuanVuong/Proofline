import { expect, it } from "vitest";
import { gst, round2 } from "../src/tax";

it("rounds to cents", () => {
  expect(round2(1.234)).toBe(1.23);
});

it("charges 10% GST", () => {
  expect(gst(100, false)).toBe(10);
});

it("charges nothing on exempt items", () => {
  expect(gst(100, true)).toBe(0);
});
