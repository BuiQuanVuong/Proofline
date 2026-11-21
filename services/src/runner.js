// Test runner: pulls shards from the work queue and is the
// only component that executes repository code. Stateless: everything it
// learns is written to DynamoDB, S3 and the event bus before the message is
// deleted, so a task can be stopped at any point.

import {
  ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { ERROR, runBaseline, runMutant } from "proofline-engine";

import { sqs } from "./aws.js";
import { EVENT, emit } from "./events.js";
import {
  CACHE_TTL_DAYS, JOB_TTL_DAYS, STATUS, expiresIn, mutantKey, objectKeys, shardKey,
} from "./keys.js";
import { batchPut, cacheItem, completeShard, getCachedResults, putObject, updateJob } from "./store.js";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";

import { REGION } from "./config.js";
import { HotCache } from "./hotcache.js";
import { NAMESPACE } from "./metrics.js";
import { setScaleInProtection } from "./protection.js";
import { prepareWorkspace } from "./workspace.js";

const VISIBILITY_S = 15 * 60;
const HEARTBEAT_MS = 5 * 60_000;

/** Structured logger. Tasks run without a CloudWatch log driver, so each shard's log also goes to S3. */
export function createLogger(context = {}) {
  const lines = [];
  const write = (level, msg, extra = {}) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, ...context, msg, ...extra });
    lines.push(line);
    console.log(line);
  };
  return {
    info: (msg, extra) => write("info", msg, extra),
    error: (msg, extra) => write("error", msg, extra),
    child: (more) => createLogger({ ...context, ...more }),
    text: () => lines.join("\n") + "\n",
  };
}

export async function handleBaseline(cfg, msg, log, { depsDir }) {
  const workdir = await prepareWorkspace(cfg, msg.jobId, msg.snapshotKey, { depsDir });
  log.info("baseline: running suite twice, then per-test-file coverage");
  const baseline = await runBaseline(workdir);
  log.info("baseline finished", { passed: baseline.passed, testFiles: baseline.testFiles.length,
    flaky: baseline.flaky.length, durationMs: baseline.durationMs });

  if (!baseline.passed) {
    await updateJob(cfg, msg.jobId, {
      status: STATUS.BASELINE_FAILED, failures: baseline.failures, baselineOutput: baseline.output.slice(-2000),
    }, { expectStatus: STATUS.BASELINE });
    await emit(cfg, "runner", EVENT.BASELINE_COMPLETED, { jobId: msg.jobId, passed: false });
    return;
  }
  const baselineKey = objectKeys.baseline(msg.jobId);
  await putObject(cfg, baselineKey, JSON.stringify(baseline));
  // Conditional, so a redelivered baseline can't move a job backwards.
  await updateJob(cfg, msg.jobId, {
    status: STATUS.PLANNING, baselineKey, baselineDurationMs: baseline.durationMs, flakyTests: baseline.flaky,
  }, { expectStatus: STATUS.BASELINE });
  await emit(cfg, "runner", EVENT.BASELINE_COMPLETED, { jobId: msg.jobId, passed: true, baselineKey });
}

const cloudwatch = new CloudWatchClient({ region: REGION });

/** Per-shard cache outcomes as Proofline/* metrics: the evidence for the cache's value. */
async function publishCacheMetrics(sources, log) {
  if (!process.env.ECS_AGENT_URI) return; // only from real runners, not local runs
  const metric = (MetricName, Value) => ({ MetricName, Value, Unit: "Count" });
  try {
    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: NAMESPACE,
      MetricData: [
        metric("CacheHotHits", sources.hot), metric("CacheDurableHits", sources.durable),
        metric("CacheCoalesced", sources.coalesced), metric("MutantsExecuted", sources.executed),
      ],
    }));
  } catch (err) {
    log.error("cache metrics not published", { error: err.message });
  }
}

/**
 * Resolve one mutant through the cache tiers:
 * Valkey hot tier -> DynamoDB durable tier -> single-flight lock -> execute.
 * Returns [result, source], source in hot | durable | coalesced | executed.
 */
async function resolveMutant(m, { cache, hot, durable, workdir }) {
  if (hot.has(m.cacheKey)) return [hot.get(m.cacheKey), "hot"];
  if (durable.has(m.cacheKey)) return [durable.get(m.cacheKey), "durable"];
  const lockMs = m.timeoutMs + 30_000;
  const lock = await cache.acquire(m.cacheKey, lockMs);
  try {
    if (lock.held) {
      // Another runner (another job sharing this mutant) is executing it right now.
      const result = await cache.waitFor(m.cacheKey, lockMs);
      if (result) return [result, "coalesced"];
    }
    const r = await runMutant(workdir, m, m.tests, m.timeoutMs);
    // Write the hot tier immediately, so any waiting runner gets the result now.
    if (r.outcome !== ERROR) await cache.put(m.cacheKey, { outcome: r.outcome, killingTest: r.killingTest ?? null });
    return [r, "executed"];
  } finally {
    if (lock.acquired) await cache.release(m.cacheKey, lock.token);
  }
}

export async function handleMutants(cfg, msg, log, { depsDir, cache = new HotCache(null) }) {
  const workdir = await prepareWorkspace(cfg, msg.jobId, msg.snapshotKey, { depsDir });
  const keys = msg.mutants.map((m) => m.cacheKey);
  const hot = await cache.getMany(keys);
  // Durable tier for the rest: a concurrent job may have produced these since planning.
  const durable = await getCachedResults(cfg, keys.filter((k) => !hot.has(k)));
  for (const [key, value] of durable) await cache.put(key, value); // warm the hot tier

  const results = [];
  const newCacheItems = [];
  const sources = { hot: 0, durable: 0, coalesced: 0, executed: 0 };
  for (const m of msg.mutants) {
    const [found, source] = await resolveMutant(m, { cache, hot, durable, workdir });
    sources[source]++;
    const r = source === "executed" ? found : { ...found, durationMs: 0 };
    if (source !== "hot" && source !== "durable" && r.outcome !== ERROR) {
      newCacheItems.push(cacheItem(m.cacheKey, r, CACHE_TTL_DAYS)); // write-through to DynamoDB
    }
    (r.detail ? log.error : log.info)("mutant", { mutantId: m.id, file: m.file, line: m.line, operator: m.operator,
      outcome: r.outcome, source, durationMs: r.durationMs, detail: r.detail });
    results.push({
      ...mutantKey(msg.jobId, m.id),
      mutantId: m.id, file: m.file, line: m.line, operator: m.operator, diff: m.diff,
      outcome: r.outcome, killingTest: r.killingTest ?? null, cacheHit: source !== "executed", cacheSource: source,
      durationMs: r.durationMs ?? 0, detail: r.detail, ttl: expiresIn(JOB_TTL_DAYS),
    });
  }
  log.info("cache", { ...sources, hotTier: cache.enabled ? "on" : "off" });
  await publishCacheMetrics(sources, log);
  // Results first, then the fan-in counter: a crash in between just redelivers the shard.
  await batchPut(cfg, [...results, ...newCacheItems, {
    ...shardKey(msg.jobId, msg.shardId), status: "DONE", mutants: results.length,
    executed: sources.executed, cacheSources: sources, ttl: expiresIn(JOB_TTL_DAYS),
  }]);
  const { completed, failed, total, done } = await completeShard(cfg, msg.jobId, msg.shardId);
  log.info("shard complete", { completed, failed, total });
  if (done) await emit(cfg, "runner", EVENT.JOB_COMPLETED, { jobId: msg.jobId, partial: failed > 0 });
}

const HANDLERS = { BASELINE: handleBaseline, MUTANTS: handleMutants };

/**
 * Long-poll the work queue until stopped. On SIGTERM (ECS scale-in) an
 * in-flight shard is released immediately rather than waiting out its
 * visibility timeout; idempotent writes make the retry safe.
 */
export async function runLoop(cfg, { depsDir, cache = new HotCache(null), exitWhenIdleS = 0, log = createLogger({ component: "runner" }) } = {}) {
  let stopping = false;
  let current = null;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info("stopping", { signal, inFlight: Boolean(current) });
    if (current) {
      await sqs.send(new ChangeMessageVisibilityCommand({
        QueueUrl: cfg.workQueueUrl, ReceiptHandle: current.ReceiptHandle, VisibilityTimeout: 0,
      })).catch(() => {});
      process.exit(0);
    }
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  let idleSince = Date.now();
  log.info("polling", { queue: cfg.workQueueUrl.split("/").pop(), depsDir });
  while (!stopping) {
    if (exitWhenIdleS && Date.now() - idleSince > exitWhenIdleS * 1000) {
      log.info("idle; exiting", { idleS: exitWhenIdleS });
      break;
    }
    const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: cfg.workQueueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 20,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }));
    for (const message of Messages) {
      current = message;
      const started = Date.now();
      let body;
      let shardLog = log;
      const protection = await setScaleInProtection(true);
      const heartbeat = setInterval(async () => {
        sqs.send(new ChangeMessageVisibilityCommand({
          QueueUrl: cfg.workQueueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: VISIBILITY_S,
        })).catch((err) => shardLog.error("heartbeat failed", { error: err.message }));
        const renewed = await setScaleInProtection(true);
        if (renewed.startsWith("unavailable")) shardLog.error("scale-in protection renewal failed", { result: renewed });
      }, HEARTBEAT_MS);
      try {
        body = JSON.parse(message.Body);
        shardLog = log.child({ jobId: body.jobId, shardId: body.shardId });
        shardLog.info("shard received", { type: body.type, attempt: Number(message.Attributes?.ApproximateReceiveCount ?? 1) });
        // Recorded in every shard log, so each run shows whether it was protected.
        (protection.startsWith("unavailable") ? shardLog.error : shardLog.info)("scale-in protection", { result: protection });
        const handler = HANDLERS[body.type];
        if (!handler) throw new Error(`unknown shard type ${body.type}`);
        await handler(cfg, body, shardLog, { depsDir, cache });
        await sqs.send(new DeleteMessageCommand({ QueueUrl: cfg.workQueueUrl, ReceiptHandle: message.ReceiptHandle }));
        shardLog.info("shard done", { durationMs: Date.now() - started });
      } catch (err) {
        // Not deleted: the queue redelivers it, and after 3 receives moves it to the DLQ.
        shardLog.error("shard failed", { error: `${err.name}: ${err.message}`, stack: err.stack?.split("\n").slice(0, 4).join(" | ") });
      } finally {
        clearInterval(heartbeat);
        current = null;
        const released = await setScaleInProtection(false);
        if (released.startsWith("unavailable")) shardLog.error("scale-in protection release failed", { result: released });
        if (body?.jobId) {
          await putObject(cfg, objectKeys.log(body.jobId, body.shardId ?? "unknown"), shardLog.text(), "text/plain")
            .catch((err) => log.error("log upload failed", { error: err.message }));
        }
      }
      idleSince = Date.now();
    }
  }
}
