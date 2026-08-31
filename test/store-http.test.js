import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryStore, slidingWindow, toHeaders, clientIp } from "limitkit";

test("THE STORE IS BOUNDED — stranger keys cannot grow the process forever", () => {
  // The bug this makes impossible: one replaced implementation kept a bare
  // Map keyed by client IP with no eviction, so every stranger who ever hit
  // the endpoint left an entry until the process died. Bounded means the
  // worst case is a very old bucket forgetting, never a leak.
  const store = new MemoryStore(100);
  for (let i = 0; i < 1_000; i++) {
    store.set(`ip:${i}`, { hits: [1] });
  }
  assert.ok(store.size <= 100, `store grew to ${store.size}`);
});

test("eviction is by recency of use, not insertion order", () => {
  const store = new MemoryStore(2);
  store.set("a", { hits: [1] });
  store.set("b", { hits: [1] });
  store.get("a"); // touch a — b becomes the eviction candidate
  store.set("c", { hits: [1] });
  assert.ok(store.get("a"), "recently-used key evicted");
  assert.equal(store.get("b"), undefined, "least-recently-used key kept");
});

test("an emptied window releases its key entirely", () => {
  const store = new MemoryStore();
  store.set("k", { hits: [1, 2] });
  store.set("k", { hits: [] });
  assert.equal(store.size, 0, "empty state must free the slot, not squat on it");
});

test("toHeaders emits the standard trio, Retry-After only on refusal", () => {
  const rl = slidingWindow({ limit: 1, windowMs: 60_000 });
  const ok = toHeaders(rl.check("k", 1_000_000));
  assert.equal(ok["X-RateLimit-Limit"], "1");
  assert.equal(ok["X-RateLimit-Remaining"], "0");
  assert.equal(ok["Retry-After"], undefined, "an allowed response must not tell anyone to wait");

  const no = toHeaders(rl.check("k", 1_000_001));
  assert.equal(no["Retry-After"], "60");
  assert.equal(no["X-RateLimit-Reset"], String(Math.ceil((1_000_000 + 60_000) / 1000)));
});

const h = (map) => ({ get: (k) => map[k.toLowerCase()] ?? null });

test("clientIp: the hop the PROXY wrote, not the one the client sent", () => {
  // A proxy APPENDS. So this header reads "<client-supplied>, <what Caddy saw>"
  // and only the last entry is unforgeable. The previous version returned
  // 9.9.9.9 here — the attacker's own value — and a test pinned it.
  assert.equal(clientIp(h({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" })), "10.0.0.1");

  // The bypass this closes: vary the header per request and every request is a
  // new bucket, so no bucket ever fills. Same real client, one key.
  const keys = new Set(
    ["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((spoof) =>
      clientIp(h({ "x-forwarded-for": `${spoof}, 203.0.113.7` })),
    ),
  );
  assert.deepEqual([...keys], ["203.0.113.7"], "a spoofed prefix must not mint new buckets");

  // A single hop is the normal case: nothing was forged, the proxy wrote it.
  assert.equal(clientIp(h({ "x-forwarded-for": "203.0.113.7" })), "203.0.113.7");
});

test("clientIp: trustedProxies moves the hop, and 0 believes nothing", () => {
  // Two of our own proxies (a CDN in front of Caddy) — the answer is one further left.
  assert.equal(
    clientIp(h({ "x-forwarded-for": "evil, 203.0.113.7, 10.0.0.1" }), { trustedProxies: 2 }),
    "203.0.113.7",
  );
  // Directly exposed: every forwarded header is written by the client, so none
  // is evidence. "unknown" is honest; a number here would look like proof.
  assert.equal(clientIp(h({ "x-forwarded-for": "evil" }), { trustedProxies: 0 }), "unknown");
  // Fewer hops than configured — still the entry our own proxy wrote.
  assert.equal(
    clientIp(h({ "x-forwarded-for": "203.0.113.7" }), { trustedProxies: 3 }),
    "203.0.113.7",
  );
});

test("clientIp: absence degrades to a shared bucket, never a throw", () => {
  assert.equal(clientIp(h({ "x-real-ip": "8.8.8.8" })), "8.8.8.8");
  // "unknown" throttles anonymous traffic COLLECTIVELY — the right failure
  // mode for abuse-blunting, and it must never throw.
  assert.equal(clientIp(h({})), "unknown");
  assert.equal(
    clientIp(h({ "x-forwarded-for": "" })),
    "unknown",
    "an empty header is not an identity",
  );
  assert.equal(
    clientIp(h({ "x-forwarded-for": " , , " })),
    "unknown",
    "separators alone are not an identity",
  );
});
