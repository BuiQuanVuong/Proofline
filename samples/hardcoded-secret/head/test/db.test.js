import { expect, it } from "vitest";
import { connectionString, tableName } from "../src/db.js";

it("prefixes table names", () => {
  expect(tableName("orders")).toBe("app_orders");
});

it("builds the connection string", () => {
  expect(connectionString("db.local")).toMatch(/^postgres:\/\/app:.+@db\.local\/shop$/);
});
