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
 * `x-forwarded-for` is a client-controlled header on a directly-exposed
 * server, so this is only as honest as the proxy in front of it — behind
 * Caddy/nginx (this fleet's shape) the first entry is what the proxy saw.
 * Falls back to "unknown" rather than throwing: a limiter keyed on "unknown"
 * throttles the anonymous bucket collectively, which is the right failure
 * mode for the abuse this exists to blunt.
 */
export function clientIp(headers: HeadersLike): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    "unknown"
  );
}
