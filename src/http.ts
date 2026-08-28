/**
 * The HTTP-facing edges — headers out, client identity in — shared because
 * they were the two things every replaced implementation ALSO wrote, each
 * slightly differently.
 *
 * No framework types. Both helpers speak the WHATWG `Headers` `get` shape,
 * which Next/Remix/undici requests all satisfy, so the package needs no
 * dependency and no per-framework adapter.
 */

import type { LimitResult } from "./limit.js";

/**
 * The standard rate-limit response headers, as orangecat's ADR-0002 specified
 * seven months before anything enforced it: X-RateLimit-Limit, -Remaining,
 * -Reset (epoch seconds), plus Retry-After on refusals only.
 *
 * Returned as a plain object so the caller spreads it into whatever response
 * type it owns — a package that constructed a `Response` would be choosing a
 * framework, and choosing a framework is how a shared package stops being
 * adoptable.
 */
export function toHeaders(result: LimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
  };
  if (!result.allowed) {
    headers["Retry-After"] = String(result.retryAfterSeconds);
  }
  return headers;
}

/** The `get` half of WHATWG Headers — what every framework request exposes. */
export type HeadersLike = { get(name: string): string | null };

/**
 * Best-effort client identity for keying a limiter.
 *
 * WHICH HOP, AND WHY IT IS NOT THE FIRST ONE
 *
 * `X-Forwarded-For` is a LIST, and a reverse proxy APPENDS to it. Caddy and
 * nginx both do. So for a request that arrived through one proxy the header
 * reads `<whatever the client sent>, <what the proxy actually saw>` — and the
 * only entry the client could not forge is the LAST one.
 *
 * This function used to return the first, with a comment asserting that was
 * "what the proxy saw", and a test pinning it. Both were wrong in the same
 * direction. The effect was that every limiter keyed on this — across every
 * adopter — could be bypassed completely by sending a random
 * `X-Forwarded-For` with each request: a new header value is a new bucket, so
 * no bucket ever fills. A limiter that cannot be tripped is not a limiter.
 * Found in orangecat's payments audit (bitbaum/orangecat#563, finding 2).
 *
 * `trustedProxies` is how many proxies of your own sit in front. Default 1 —
 * one reverse proxy is the overwhelmingly common shape and the only one where
 * a default can be safe. Two proxies (a CDN in front of your own) means 2, and
 * the answer moves one further left.
 *
 * `trustedProxies: 0` means the server is exposed directly, so EVERY forwarded
 * header is written by the client and none can be believed: the result is
 * "unknown" rather than a number that looks like evidence.
 *
 * Falls back to "unknown" rather than throwing: a limiter keyed on "unknown"
 * throttles the anonymous bucket collectively, which is the right failure mode
 * for the abuse this exists to blunt.
 */
export function clientIp(
  headers: HeadersLike,
  opts: { trustedProxies?: number } = {},
): string {
  const trusted = opts.trustedProxies ?? 1;
  if (trusted > 0) {
    const hops = (headers.get("x-forwarded-for") ?? "")
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    // Count from the RIGHT: the rightmost hop was written by the proxy nearest
    // us. Clamped, because a shorter chain than configured means fewer proxies
    // ran than expected — the leftmost is then the only candidate we have, and
    // it is still the one our own proxy wrote.
    if (hops.length > 0) return hops[Math.max(0, hops.length - trusted)]!;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}
