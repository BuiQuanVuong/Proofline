// DynamoDB and S3 access for jobs, shards, mutant results and the durable
// result cache. All writes are idempotent so redelivered messages are safe.

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  BatchGetCommand, BatchWriteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import { ddb, s3 } from "./aws.js";
import { cacheItemKey, expiresIn, jobKey, JOB_TTL_DAYS } from "./keys.js";

const chunk = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
  items.slice(i * size, i * size + size));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ jobs

export async function createJob(cfg, job) {
  await ddb.send(new PutCommand({
    TableName: cfg.table,
    Item: {
      ...jobKey(job.jobId), ...job,
      GSI1PK: `REPO#${job.repo}`, GSI1SK: job.createdAt,
      ttl: expiresIn(JOB_TTL_DAYS),
    },
    ConditionExpression: "attribute_not_exists(PK)",
  }));
}

export async function getJob(cfg, jobId) {
  const { Item } = await ddb.send(new GetCommand({ TableName: cfg.table, Key: jobKey(jobId), ConsistentRead: true }));
  return Item ?? null;
}

/**
 * Set fields on a job. With `expectStatus`, the update only applies if the job
 * is in that status; returns false if another worker got there first.
 */
export async function updateJob(cfg, jobId, fields, { expectStatus } = {}) {
  const names = {};
  const values = {};
  const sets = Object.entries(fields).map(([k, v], i) => {
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    return `#f${i} = :v${i}`;
  });
  if (expectStatus) {
    names["#status"] = "status";
    values[":expected"] = expectStatus;
  }
  try {
    await ddb.send(new UpdateCommand({
      TableName: cfg.table,
      Key: jobKey(jobId),
      UpdateExpression: `SET ${sets.join(", ")}`,
      ConditionExpression: expectStatus ? "#status = :expected" : "attribute_exists(PK)",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/**
 * Fan-in: add a shard to the job's completed set and return the
 * new size. Adding to a set is idempotent, so a redelivered shard can't
 * double-count.
 */
export async function completeShard(cfg, jobId, shard) {
  return addShardToSet(cfg, jobId, "completedShards", shard);
}

/** A shard that exhausted its retries (moved to the DLQ) still counts towards fan-in. */
export async function failShard(cfg, jobId, shard) {
  return addShardToSet(cfg, jobId, "failedShards", shard);
}

async function addShardToSet(cfg, jobId, attribute, shard) {
  const { Attributes } = await ddb.send(new UpdateCommand({
    TableName: cfg.table,
    Key: jobKey(jobId),
    UpdateExpression: "ADD #set :s",
    ConditionExpression: "attribute_exists(PK)",
    ExpressionAttributeNames: { "#set": attribute },
    ExpressionAttributeValues: { ":s": new Set([shard]) },
    ReturnValues: "ALL_NEW",
  }));
  const completed = Attributes.completedShards?.size ?? 0;
  const failed = Attributes.failedShards?.size ?? 0;
  return { completed, failed, total: Attributes.shardsTotal, done: completed + failed >= Attributes.shardsTotal };
}

// ----------------------------------------------------------- batch writes

export async function batchPut(cfg, items) {
  for (const group of chunk(items, 25)) {
    let pending = group.map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; pending.length; attempt++) {
      if (attempt === 6) throw new Error(`BatchWrite: ${pending.length} items unprocessed after retries`);
      if (attempt) await sleep(100 * 2 ** attempt);
      const { UnprocessedItems } = await ddb.send(new BatchWriteCommand({ RequestItems: { [cfg.table]: pending } }));
      pending = UnprocessedItems?.[cfg.table] ?? [];
    }
  }
}

export async function queryMutantResults(cfg, jobId) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: cfg.table,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :mut)",
      ExpressionAttributeValues: { ":pk": `JOB#${jobId}`, ":mut": "MUT#" },
      ExclusiveStartKey,
    }));
    items.push(...page.Items);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// ------------------------------------------------- durable result cache

/** Look up content-addressed results; returns Map<cacheKey, {outcome, killingTest}>. */
export async function getCachedResults(cfg, cacheKeys) {
  const found = new Map();
  for (const group of chunk([...new Set(cacheKeys)], 100)) {
    let pending = { [cfg.table]: { Keys: group.map(cacheItemKey), ProjectionExpression: "PK, outcome, killingTest" } };
    for (let attempt = 0; pending?.[cfg.table]?.Keys?.length; attempt++) {
      if (attempt === 6) throw new Error("BatchGet: keys unprocessed after retries");
      if (attempt) await sleep(100 * 2 ** attempt);
      const { Responses, UnprocessedKeys } = await ddb.send(new BatchGetCommand({ RequestItems: pending }));
      for (const item of Responses?.[cfg.table] ?? []) {
        found.set(item.PK.slice("CACHE#".length), { outcome: item.outcome, killingTest: item.killingTest ?? null });
      }
      pending = UnprocessedKeys;
    }
  }
  return found;
}

export const cacheItem = (cacheKey, { outcome, killingTest }, ttlDays) => ({
  ...cacheItemKey(cacheKey), outcome, killingTest: killingTest ?? null, ttl: expiresIn(ttlDays),
});

// ------------------------------------------------------------ objects

export async function putObject(cfg, Key, Body, ContentType = "application/json") {
  await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key, Body, ContentType }));
}

/** Size in bytes, or null if the object doesn't exist. */
export async function objectSize(cfg, Key) {
  try {
    const { ContentLength } = await s3.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key }));
    return ContentLength;
  } catch (err) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

export async function getJsonObject(cfg, Key) {
  const { Body } = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key }));
  return JSON.parse(await Body.transformToString());
}
