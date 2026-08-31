/**
 * The clock is an argument everywhere, so every case below proves its claim
 * without sleeping — the thing none of the twelve replaced implementations
 * could do, which is why none of them had tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { slidingWindow, fixedWindow, MemoryStore } from "limitkit";

const RULE = { limit: 3, windowMs: 60_000 };
const T0 = 1_000_000;

test("sliding: allows up to the limit, then refuses", () => {
  const rl = slidingWindow(RULE);
  assert.equal(rl.check("k", T0).allowed, true);
  assert.equal(rl.check("k", T0 + 1).allowed, true);
  assert.equal(rl.check("k", T0 + 2).allowed, true);
  const refused = rl.check("k", T0 + 3);
  assert.equal(refused.allowed, false);
  assert.equal(refused.remaining, 0);
});

test("sliding: the refusal names WHEN, derived from the oldest hit", () => {
  const rl = slidingWindow(RULE);
  rl.check("k", T0);
  rl.check("k", T0 + 10_000);
  rl.check("k", T0 + 20_000);
  const refused = rl.check("k", T0 + 30_000);
  // The oldest hit (T0) ages out at T0+60s; from T0+30s that is 30s away.
  assert.equal(refused.retryAfterSeconds, 30);
  assert.equal(refused.resetAt, T0 + 60_000);
});

test("sliding: the window actually slides — old hits age out one by one", () => {
  const rl = slidingWindow(RULE);
  rl.check("k", T0);
  rl.check("k", T0 + 10_000);
  rl.check("k", T0 + 20_000);
  // At T0+61s the first hit has aged out: exactly one slot free.
  assert.equal(rl.check("k", T0 + 61_000).allowed, true);
  assert.equal(rl.check("k", T0 + 61_001).allowed, false);
});

test("A REFUSAL COUNTS NOTHING — hammering cannot extend the lockout", () => {
  // The failure this prevents: an attacker retrying in a loop keeps the
  // window eternally full, and the legitimate user behind the same NAT never
  // gets back in. Refusals must not feed the counter.
  const rl = slidingWindow(RULE);
  rl.check("k", T0);
  rl.check("k", T0 + 1);
  rl.check("k", T0 + 2);
  for (let i = 0; i < 50; i++) rl.check("k", T0 + 10_000 + i);
  // All three real hits age out at T0+60_002 regardless of the hammering.
  assert.equal(rl.check("k", T0 + 61_000).allowed, true);
});

test("keys are independent", () => {
  const rl = slidingWindow(RULE);
  rl.check("a", T0);
  rl.check("a", T0);
  rl.check("a", T0);
  assert.equal(rl.check("a", T0 + 1).allowed, false);
  assert.equal(rl.check("b", T0 + 1).allowed, true);
});

test("peek decides without counting", () => {
  const rl = slidingWindow(RULE);
  for (let i = 0; i < 10; i++) rl.peek("k", T0 + i);
  assert.equal(rl.check("k", T0 + 11).allowed, true, "peeks must not consume the allowance");
});

test("fixed: the whole allowance returns when the bucket rolls", () => {
  const rl = fixedWindow(RULE);
  const start = 1_200_000; // aligned: divisible by 60_000
  rl.check("k", start);
  rl.check("k", start + 1);
  rl.check("k", start + 2);
  assert.equal(rl.check("k", start + 3).allowed, false);
  assert.equal(rl.check("k", start + 60_000).allowed, true, "new bucket, fresh allowance");
});

test("fixed: refusal points at the bucket boundary", () => {
  const rl = fixedWindow(RULE);
  const start = 1_200_000;
  rl.check("k", start);
  rl.check("k", start);
  rl.check("k", start);
  const refused = rl.check("k", start + 45_000);
  assert.equal(refused.retryAfterSeconds, 15);
});

test("a shared store serves multiple limiters without cross-talk", () => {
  const store = new MemoryStore();
  const login = slidingWindow({ limit: 1, windowMs: 60_000 }, store);
  const search = slidingWindow({ limit: 5, windowMs: 60_000 }, store);
  // Same underlying store, DIFFERENT keys per concern — the app namespaces.
  assert.equal(login.check("login:1.2.3.4", T0).allowed, true);
  assert.equal(login.check("login:1.2.3.4", T0 + 1).allowed, false);
  assert.equal(search.check("search:1.2.3.4", T0 + 1).allowed, true);
});
