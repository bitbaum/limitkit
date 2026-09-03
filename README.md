# limitkit

Rate limiting as a **decision**, not a middleware.

```bash
npm install github:catomean/limitkit#v0.1.0
```

## Why this exists

Twelve near-identical rate limiters were found across nine repos of one fleet —
orangecat alone carried four, and its ADR to unify them sat **"Proposed" for
seven months** while the count doubled. What actually varied between the twelve
was one thing: *where the counts live*. Everything else — the window
arithmetic, the refusal shape, the headers, the client-IP dance — was the same
idea written twelve slightly different ways, with independently re-invented
bugs (one kept an unbounded `Map` keyed by stranger IPs: a slow memory leak
fed by the public internet).

So the algorithm is fixed and the store is the seam.

## Use

```ts
import { slidingWindow, clientIp, toHeaders } from 'limitkit';

const loginLimiter = slidingWindow({ limit: 5, windowMs: 15 * 60_000 });

export async function POST(req: Request) {
  const result = loginLimiter.check(`login:${clientIp(req.headers)}`);
  if (!result.allowed) {
    return Response.json(
      { error: 'Too many attempts' },
      { status: 429, headers: toHeaders(result) },
    );
  }
  // ... the actual work, with toHeaders(result) on the success path too if you like
}
```

- **`slidingWindow(rule, store?)`** — N hits per *trailing* window. The default;
  it is what most hand-rolled "fixed" windows actually meant.
- **`fixedWindow(rule, store?)`** — N hits per aligned bucket. Cheaper, burstier
  at the boundary (up to 2N around a roll). Choose it by name, not by accident.
- **`check`** counts the hit when allowed and **counts nothing when refused** —
  a hammered key recovers the moment the attacker stops, instead of locking the
  legitimate user behind the same NAT out forever.
- The refusal's `retryAfterSeconds` is **derived from the actual oldest hit**,
  never fabricated. "Try again shortly" on a window that opens in an hour is a
  lie; this package refuses to tell it.

## The store seam

```ts
interface Store {
  get(key: string): { hits: number[] } | undefined;
  set(key: string, state: { hits: number[] }): void;
}
```

The default `MemoryStore` is **bounded** (LRU past `maxKeys`, default 5 000) —
the unbounded-Map leak is impossible by construction. It is per-process:
behind N workers the effective limit multiplies by N, which is fine for
blunting scripted abuse and wrong for billing enforcement. For shared state,
implement those two methods over Redis/Postgres — an adapter is a dozen lines,
because the store holds and the algorithm decides.

## HTTP edges

- **`toHeaders(result)`** — `X-RateLimit-Limit` / `-Remaining` / `-Reset`, plus
  `Retry-After` on refusals only. A plain object you spread into your own
  response; constructing a `Response` would mean choosing your framework for
  you.
- **`clientIp(headers, { trustedProxies = 1 })`** — the forwarded hop your own
  proxy wrote, then `x-real-ip`, then `"unknown"`. A proxy **appends** to
  `X-Forwarded-For`, so the header reads `<what the client sent>, <what the
  proxy saw>` and only the **last** entry is unforgeable. Reading the first
  one — which this did before v0.2.0 — lets a caller vary the header per
  request, mint a fresh bucket each time and never trip the limit at all.
  Set `trustedProxies: 2` when a CDN sits in front of your proxy, or `0` when
  the server is exposed directly and no forwarded header can be believed.
- **No HTTP client, no middleware, no framework types** — the package supplies
  the decision; your app keeps its conventions.
- **No limit values** — how many attempts a login route allows is app
  semantics. Centralize the rule; assert the numbers locally.
- **No distributed store** — that is *your* Redis and *your* ops posture. The
  seam is two methods.

Everything takes `now` as an argument, so all of it is testable without
sleeping — which is why this package has tests and the twelve files it
replaces, collectively, had almost none.

## Development

```bash
pnpm run verify  # lint + typecheck + build + test (tests import by package name)
```

MIT.
