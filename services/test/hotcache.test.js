// The hot cache's tiering, single-flight and circuit-breaker logic against a
// fake Valkey (no network).

import assert from "node:assert/strict";
import { test } from "node:test";

import { HotCache } from "../src/hotcache.js";

/** Just enough of Valkey's semantics: GET, MGET, SET [EX|PX] [NX], EVAL (release script). */
class FakeValkey {
  constructor({ failing = false } = {}) {
    this.data = new Map();
    this.failing = failing;
    this.calls = 0;
  }

  check() {
    this.calls++;
    if (this.failing) throw Object.assign(new Error("connection refused"), { name: "Error" });
  }

  live(key) {
    const entry = this.data.get(key);
    if (entry && entry.expires && entry.expires <= Date.now()) this.data.delete(key);
    return this.data.get(key)?.value ?? null;
  }

  async get(key) { this.check(); return this.live(key); }
  async mget(...keys) { this.check(); return keys.map((k) => this.live(k)); }
  async set(key, value, mode, ttl, nx) {
    this.check();
    if (nx === "NX" && this.live(key) !== null) return null;
    const ms = mode === "EX" ? ttl * 1000 : ttl;
    this.data.set(key, { value, expires: Date.now() + ms });
    return "OK";
  }
  async eval(_script, _n, key, token) {
    this.check();
    if (this.live(key) === token) {
      this.data.delete(key);
      return 1;
    }
    return 0;
  }
}

const result = { outcome: "KILLED", killingTest: "test/a.test.js > x" };

test("read-through: getMany returns only the keys present", async () => {
  const cache = new HotCache(new FakeValkey());
  await cache.put("k1", result);
  const found = await cache.getMany(["k1", "k2"]);
  assert.deepEqual([...found.keys()], ["k1"]);
  assert.deepEqual(found.get("k1"), result);
  assert.deepEqual(await cache.getMany([]), new Map());
});

test("single-flight: one runner holds the lock, the other is told it's held", async () => {
  const fake = new FakeValkey();
  const a = new HotCache(fake);
  const b = new HotCache(fake);
  const first = await a.acquire("k", 5000);
  const second = await b.acquire("k", 5000);
  assert.equal(first.acquired, true);
  assert.deepEqual(second, { acquired: false, held: true });
  // Only the owner can release.
  await b.release("k", "not-the-token");
  assert.deepEqual(await b.acquire("k", 5000), { acquired: false, held: true });
  await a.release("k", first.token);
  assert.equal((await b.acquire("k", 5000)).acquired, true);
});

test("a waiting runner receives the owner's result instead of re-running", async () => {
  const fake = new FakeValkey();
  const owner = new HotCache(fake);
  const waiter = new HotCache(fake, { pollMs: 10 });
  const lock = await owner.acquire("k", 5000);
  setTimeout(async () => {
    await owner.put("k", result);
    await owner.release("k", lock.token);
  }, 50);
  assert.deepEqual(await waiter.waitFor("k", 5000), result);
});

test("if the owner gives up without a result, the waiter is told to run it", async () => {
  const fake = new FakeValkey();
  const owner = new HotCache(fake);
  const waiter = new HotCache(fake, { pollMs: 10 });
  const lock = await owner.acquire("k", 5000);
  setTimeout(() => owner.release("k", lock.token), 30);
  assert.equal(await waiter.waitFor("k", 5000), null);
});

test("circuit breaker: errors fall back to 'no cache' and stop calling the cache for a minute", async () => {
  let clock = 1_000_000;
  const fake = new FakeValkey({ failing: true });
  const cache = new HotCache(fake, { now: () => clock });
  assert.deepEqual(await cache.getMany(["k"]), new Map());
  assert.equal(cache.enabled, false);
  assert.deepEqual(await cache.acquire("k", 1000), { acquired: false, held: false });
  await cache.put("k", result);
  assert.equal(fake.calls, 1); // nothing after the first failure

  fake.failing = false;
  clock += 61_000;
  assert.equal(cache.enabled, true);
  await cache.put("k", result);
  assert.equal((await cache.getMany(["k"])).size, 1);
});

test("a disabled cache (no host configured) is a harmless no-op", async () => {
  const cache = new HotCache(null);
  assert.equal(cache.enabled, false);
  assert.deepEqual(await cache.getMany(["k"]), new Map());
  assert.deepEqual(await cache.acquire("k", 1000), { acquired: false, held: false });
  assert.equal(await cache.waitFor("k", 1000), null);
});
