// Phase 1: data plane.
//
// Every resource is created with its tags (accounts with tag-based access
// control deny some calls on untagged resources), then its settings are
// reconciled so re-running converges.

import {
  CreateTableCommand, DeleteTableCommand, DescribeTableCommand, DescribeTimeToLiveCommand, DynamoDBClient,
  TagResourceCommand as TagTableCommand, UpdateTimeToLiveCommand, waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import {
  CreateEventBusCommand, DeleteArchiveCommand, DeleteEventBusCommand, DescribeEventBusCommand,
  EventBridgeClient, TagResourceCommand as TagBusCommand,
} from "@aws-sdk/client-eventbridge";
import {
  CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command, PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand, PutPublicAccessBlockCommand, S3Client,
} from "@aws-sdk/client-s3";
import { S3ControlClient, TagResourceCommand as TagBucketCommand } from "@aws-sdk/client-s3-control";
import {
  CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, SQSClient, SetQueueAttributesCommand,
  TagQueueCommand,
} from "@aws-sdk/client-sqs";
import { DeleteParametersCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

import { config, name, tagList, tagMap } from "../config.js";
import { isError, log } from "../lib/log.js";

const { region, accountId } = config;

export const DATA = {
  table: name("main"),
  bucket: name("artifacts"),
  queue: name("work"),
  dlq: name("work-dlq"),
  bus: name("bus"),
  archive: name("bus-archive"), // never created; teardown still removes one if present
  paramPrefix: config.paramPrefix,
};

export const queueUrl = (queue) => `https://sqs.${region}.amazonaws.com/${accountId}/${queue}`;

/**
 * Re-apply tags to an existing resource. Best-effort: the account denies some
 * tag changes after creation (e.g. sqs:TagQueue), and tags are always set on
 * create anyway. audit-tags.js verifies the result.
 */
async function retag(label, fn) {
  try {
    await fn();
  } catch (err) {
    if (!isError(err, "AccessDenied", "AccessDeniedException")) throw err;
    log("skipped", `  re-tag ${label}`, "denied after creation; tags were set on create (verify with audit-tags.js)");
  }
}

// Object expiry by prefix: intermediate artefacts are
// garbage-collected; reports are small and kept.
const LIFECYCLE = [
  ["snapshots/", 1],
  ["coverage/", 1],
  ["logs/", 7],
  ["envs/", 14],
];

async function table() {
  const db = new DynamoDBClient({ region });
  const TableName = DATA.table;
  try {
    await db.send(new CreateTableCommand({
      TableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: ["PK", "SK", "GSI1PK", "GSI1SK"].map((n) => ({ AttributeName: n, AttributeType: "S" })),
      KeySchema: [{ AttributeName: "PK", KeyType: "HASH" }, { AttributeName: "SK", KeyType: "RANGE" }],
      GlobalSecondaryIndexes: [{
        IndexName: "GSI1",
        KeySchema: [{ AttributeName: "GSI1PK", KeyType: "HASH" }, { AttributeName: "GSI1SK", KeyType: "RANGE" }],
        Projection: { ProjectionType: "ALL" },
      }],
      Tags: tagList(),
    }));
    log("created", `DynamoDB table ${TableName}`, "(on-demand, PK/SK + GSI1)");
  } catch (err) {
    if (!isError(err, "ResourceInUseException")) throw err;
    log("exists", `DynamoDB table ${TableName}`);
  }
  await waitUntilTableExists({ client: db, maxWaitTime: 300 }, { TableName });
  const { Table } = await db.send(new DescribeTableCommand({ TableName }));
  await retag("table", () => db.send(new TagTableCommand({ ResourceArn: Table.TableArn, Tags: tagList() })));

  const { TimeToLiveDescription } = await db.send(new DescribeTimeToLiveCommand({ TableName }));
  if (["ENABLED", "ENABLING"].includes(TimeToLiveDescription?.TimeToLiveStatus)) {
    log("ok", "  TTL on attribute ttl", TimeToLiveDescription.TimeToLiveStatus.toLowerCase());
  } else {
    await db.send(new UpdateTimeToLiveCommand({
      TableName, TimeToLiveSpecification: { Enabled: true, AttributeName: "ttl" },
    }));
    log("updated", "  TTL on attribute ttl", "enabled");
  }
  return Table.TableArn;
}

async function bucket() {
  const s3 = new S3Client({ region });
  const Bucket = DATA.bucket;
  try {
    await s3.send(new CreateBucketCommand({ Bucket, CreateBucketConfiguration: { LocationConstraint: region } }));
    log("created", `S3 bucket ${Bucket}`);
  } catch (err) {
    if (!isError(err, "BucketAlreadyOwnedByYou")) throw err;
    log("exists", `S3 bucket ${Bucket}`);
  }

  // Tag before anything else: the account's deny policy refuses some bucket
  // settings until the resource is tagged. put-bucket-tagging fails here
  // under ABAC, so tags go through S3 Control.
  await new S3ControlClient({ region }).send(new TagBucketCommand({
    AccountId: accountId, ResourceArn: `arn:aws:s3:::${Bucket}`, Tags: tagList(),
  }));
  log("ok", "  tagged via S3 Control");

  // Each setting is attempted separately so one denial doesn't hide the rest.
  const setting = async (label, fn, ifDenied) => {
    try {
      await fn();
      log("ok", `  ${label}`);
    } catch (err) {
      if (!isError(err, "AccessDenied", "AccessDeniedException")) throw err;
      log("WARNING", `  ${label} denied`, ifDenied);
    }
  };
  await setting("public access blocked", () => s3.send(new PutPublicAccessBlockCommand({
    Bucket,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true,
    },
  })), "new buckets block public access by default; check in the console");
  await setting("AES256 default encryption", () => s3.send(new PutBucketEncryptionCommand({
    Bucket,
    ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
  })), "harmless: S3 applies SSE-S3 (AES256) to new buckets by default");
  await setting(`lifecycle ${LIFECYCLE.map(([p, d]) => `${p}${d}d`).join(" ")}`, () =>
    s3.send(new PutBucketLifecycleConfigurationCommand({
      Bucket,
      LifecycleConfiguration: {
        Rules: [
          ...LIFECYCLE.map(([prefix, days]) => ({
            ID: `expire-${prefix.replace("/", "")}`, Status: "Enabled", Filter: { Prefix: prefix }, Expiration: { Days: days },
          })),
          { ID: "abort-incomplete-uploads", Status: "Enabled", Filter: { Prefix: "" },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
        ],
      },
    })), "IMPORTANT: garbage collection then needs a scheduled cleanup Lambda instead");
  return `arn:aws:s3:::${Bucket}`;
}

async function queue(QueueName, Attributes) {
  const sqs = new SQSClient({ region });
  let url;
  try {
    ({ QueueUrl: url } = await sqs.send(new CreateQueueCommand({ QueueName, Attributes, tags: tagMap() })));
    log("ok", `SQS queue ${QueueName}`);
  } catch (err) {
    // Same name with different attributes: reconcile instead of failing.
    if (!isError(err, "QueueNameExists", "QueueAlreadyExists")) throw err;
    url = queueUrl(QueueName);
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl: url, Attributes }));
    log("updated", `SQS queue ${QueueName}`, "attributes reconciled");
  }
  await retag(`queue ${QueueName}`, () => sqs.send(new TagQueueCommand({ QueueUrl: url, Tags: tagMap() })));
  const { Attributes: attrs } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["QueueArn"] }));
  return { url, arn: attrs.QueueArn };
}

async function queues() {
  const dlq = await queue(DATA.dlq, {
    MessageRetentionPeriod: String(14 * 24 * 3600),
    SqsManagedSseEnabled: "true",
  });
  const work = await queue(DATA.queue, {
    // Longer than the longest shard (timeouts in the engine scale from baseline durations).
    VisibilityTimeout: String(15 * 60),
    ReceiveMessageWaitTimeSeconds: "20",
    MessageRetentionPeriod: String(4 * 24 * 3600),
    SqsManagedSseEnabled: "true",
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: 3 }),
  });
  log("ok", "  redrive to DLQ after 3 receives; visibility 15 min; long polling 20 s");
  return { work, dlq };
}

async function bus() {
  const eb = new EventBridgeClient({ region });
  let arn;
  try {
    ({ EventBusArn: arn } = await eb.send(new CreateEventBusCommand({ Name: DATA.bus, Tags: tagList() })));
    log("created", `EventBridge bus ${DATA.bus}`);
  } catch (err) {
    if (!isError(err, "ResourceAlreadyExistsException")) throw err;
    ({ Arn: arn } = await eb.send(new DescribeEventBusCommand({ Name: DATA.bus })));
    await retag("bus", () => eb.send(new TagBusCommand({ ResourceARN: arn, Tags: tagList() })));
    log("exists", `EventBridge bus ${DATA.bus}`);
  }
  // No event archive: archives can't be tagged, and every resource must carry
  // the configured tags.
  return arn;
}

async function parameters(values) {
  const ssm = new SSMClient({ region });
  for (const [key, Value] of Object.entries(values)) {
    const Name = `${DATA.paramPrefix}/${key}`;
    try {
      await ssm.send(new PutParameterCommand({ Name, Value, Type: "String", Tags: tagList() }));
      log("created", `parameter ${Name}`);
    } catch (err) {
      if (!isError(err, "ParameterAlreadyExists")) throw err;
      // Tags can't be combined with Overwrite; they were set on creation.
      await ssm.send(new PutParameterCommand({ Name, Value, Type: "String", Overwrite: true }));
      log("ok", `parameter ${Name}`);
    }
  }
}

export async function deployData() {
  const tableArn = await table();
  const bucketArn = await bucket();
  const { work, dlq } = await queues();
  const busArn = await bus();
  await parameters({
    "table": DATA.table,
    "bucket": DATA.bucket,
    "work-queue-url": work.url,
    "dlq-url": dlq.url,
    "event-bus": DATA.bus,
  });
  return { tableArn, bucketArn, workQueueArn: work.arn, dlqArn: dlq.arn, busArn };
}

/** Deletes phase 1 resources. Later phases' rules/targets must be removed first. */
export async function teardownData({ apply }) {
  const step = async (label, fn) => {
    if (!apply) return log("would", `delete ${label}`);
    try {
      await fn();
      log("deleted", label);
    } catch (err) {
      if (isError(err, "ResourceNotFoundException", "NoSuchBucket", "QueueDoesNotExist",
        "AWS.SimpleQueueService.NonExistentQueue", "ParameterNotFound")) log("absent", label);
      else log("FAILED", label, `${err.name}: ${err.message}`);
    }
  };

  const ssm = new SSMClient({ region });
  const keys = ["table", "bucket", "work-queue-url", "dlq-url", "event-bus"];
  await step(`parameters ${DATA.paramPrefix}/*`, () =>
    ssm.send(new DeleteParametersCommand({ Names: keys.map((k) => `${DATA.paramPrefix}/${k}`) })));

  const eb = new EventBridgeClient({ region });
  await step(`archive ${DATA.archive}`, () => eb.send(new DeleteArchiveCommand({ ArchiveName: DATA.archive })));
  await step(`EventBridge bus ${DATA.bus}`, () => eb.send(new DeleteEventBusCommand({ Name: DATA.bus })));

  const sqs = new SQSClient({ region });
  await step(`SQS queue ${DATA.queue}`, () => sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl(DATA.queue) })));
  await step(`SQS queue ${DATA.dlq}`, () => sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl(DATA.dlq) })));

  const s3 = new S3Client({ region });
  await step(`S3 bucket ${DATA.bucket} (emptied first)`, async () => {
    let ContinuationToken;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: DATA.bucket, ContinuationToken }));
      if (page.Contents?.length) {
        await s3.send(new DeleteObjectsCommand({
          Bucket: DATA.bucket, Delete: { Objects: page.Contents.map(({ Key }) => ({ Key })) },
        }));
      }
      ContinuationToken = page.NextContinuationToken;
    } while (ContinuationToken);
    await s3.send(new DeleteBucketCommand({ Bucket: DATA.bucket }));
  });

  const db = new DynamoDBClient({ region });
  await step(`DynamoDB table ${DATA.table}`, () => db.send(new DeleteTableCommand({ TableName: DATA.table })));
}
