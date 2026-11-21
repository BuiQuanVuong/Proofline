import { expect, it } from "vitest";
import { tableName } from "../src/db.js";

it("prefixes table names", () => {
  expect(tableName("orders")).toBe("app_orders");
});
