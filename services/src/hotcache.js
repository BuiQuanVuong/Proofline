// In-memory hot tier for the runners: ElastiCache for Valkey. Two jobs:
//   1. a fast read-through copy of mutant results, in front of DynamoDB;
//   2. single-flight locks, so concurrent jobs that share a mutant run it once.
// The cache may only make a shard faster, never fail it: every call has a
// short timeout, and any error opens a circuit breaker that disables the cache
// for a minute while the runner falls back to DynamoDB alone.

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { randomBytes } from "node:crypto";
import Redis from "ioredis";

import { REGION } from "./config.js";

const RESULT_PREFIX = "pl:result:";
const LOCK_PREFIX = "pl:lock:";
const RESULT_TTL_S = 6 * 3600;
const BREAKER_MS = 60_000;
const POLL_MS = 500;
// Delete the lock only if we still own it (another runner may hold it after expiry).
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HotCache {
  /** `client`: an ioredis-compatible client, or null for a disabled cache. */
  constructor(client, { log = null, now = Date.now, pollMs = POLL_MS } = {}) {
    this.client = client;
    this.log = log;
    this.now = now;
    this.pollMs = pollMs;
    this.disabledUntil = 0;
  }

  get enabled() {
    return Boolean(this.client) && this.now() >= this.disabledUntil;
  }

  async guard(fn, fallback) {
    if (!this.enabled) return fallback;
    try {
      return await fn(this.client);
    } catch (err) {
      this.disabledUntil = this.now() + BREAKER_MS;
      this.log?.error("hot cache unavailable; using DynamoDB only for 60 s", { error: `${err.name}: ${err.message}` });
      return fallback;
    }
  }

  /** Map<cacheKey, result> of the keys present. */
  async getMany(keys) {
    if (keys.length === 0) return new Map();
    return this.guard(async (c) => {
      const values = await c.mget(...keys.map((k) => RESULT_PREFIX + k));
      return new Map(keys.flatMap((k, i) => (values[i] ? [[k, JSON.parse(values[i])]] : [])));
    }, new Map());
  }

  async put(key, result) {
    await this.guard((c) => c.set(RESULT_PREFIX + key, JSON.stringify(result), "EX", RESULT_TTL_S), null);
  }

  /**
   * Try to become the only runner executing `key`.
   * Returns { acquired: true, token } | { acquired: false, held: true } |
   * { acquired: false, held: false } when the cache is unavailable (just run it).
   */
  async acquire(key, ttlMs) {
    const token = randomBytes(8).toString("hex");
    const reply = await this.guard((c) => c.set(LOCK_PREFIX + key, token, "PX", Math.ceil(ttlMs), "NX"), undefined);
    if (reply === undefined) return { acquired: false, held: false };
    return reply === "OK" ? { acquired: true, token } : { acquired: false, held: true };
  }

  async release(key, token) {
    await this.guard((c) => c.eval(RELEASE, 1, LOCK_PREFIX + key, token), null);
  }

  /**
   * Wait for another runner's result. Returns it, or null if the lock was
   * released or expired without one (that runner failed: run it ourselves).
   */
  async waitFor(key, maxMs) {
    const deadline = this.now() + maxMs;
    while (this.now() < deadline && this.enabled) {
      const [result] = [...(await this.getMany([key])).values()];
      if (result) return result;
      const locked = await this.guard((c) => c.get(LOCK_PREFIX + key), null);
      if (!locked) return (await this.getMany([key])).get(key) ?? null;
      await sleep(this.pollMs);
    }
    return null;
  }
}

/**
 * Connect using the task definition's environment. Without
 * PROOFLINE_CACHE_HOST (e.g. local runs) the cache is simply disabled.
 */
export async function connectHotCache(log) {
  const host = process.env.PROOFLINE_CACHE_HOST;
  if (!host) {
    log.info("hot cache not configured; using DynamoDB only");
    return new HotCache(null, { log });
  }
  try {
    const { SecretString: password } = await new SecretsManagerClient({ region: REGION })
      .send(new GetSecretValueCommand({ SecretId: process.env.PROOFLINE_CACHE_SECRET }));
    const client = new Redis({
      host, port: Number(process.env.PROOFLINE_CACHE_PORT ?? 6379), password,
      tls: {}, // in-transit encryption is required on the replication group
      lazyConnect: true, connectTimeout: 3000, commandTimeout: 1000,
      maxRetriesPerRequest: 1, enableOfflineQueue: false,
      retryStrategy: (attempt) => Math.min(attempt * 500, 5000),
    });
    client.on("error", () => {}); // surfaced through guard() instead of crashing the runner
    await client.connect();
    log.info("hot cache connected", { host, port: process.env.PROOFLINE_CACHE_PORT });
    return new HotCache(client, { log });
  } catch (err) {
    log.error("hot cache connection failed; using DynamoDB only", { error: `${err.name}: ${err.message}` });
    return new HotCache(null, { log });
  }
}
