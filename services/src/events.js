// Lifecycle events on the EventBridge bus.

import { PutEventsCommand } from "@aws-sdk/client-eventbridge";

import { events } from "./aws.js";

export const EVENT = Object.freeze({
  JOB_CREATED: "JobCreated",
  BASELINE_COMPLETED: "BaselineCompleted",
  JOB_COMPLETED: "JobCompleted",
  REPORT_READY: "ReportReady",
});

export async function emit(cfg, source, type, detail) {
  const { FailedEntryCount, Entries } = await events.send(new PutEventsCommand({
    Entries: [{
      EventBusName: cfg.bus,
      Source: `proofline.${source}`,
      DetailType: type,
      Detail: JSON.stringify({ schemaVersion: 1, ...detail }),
    }],
  }));
  if (FailedEntryCount) {
    throw new Error(`PutEvents ${type} failed: ${Entries[0].ErrorCode} ${Entries[0].ErrorMessage}`);
  }
}
