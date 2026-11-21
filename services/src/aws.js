// Shared AWS clients, created once per process (or Lambda container).

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { REGION } from "./config.js";

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
export const s3 = new S3Client({ region: REGION });
export const sqs = new SQSClient({ region: REGION });
export const events = new EventBridgeClient({ region: REGION });
