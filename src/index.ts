/**
 * limitkit — rate limiting as a DECISION, not a middleware.
 *
 * Extracted 2026-08-20 from twelve near-identical implementations across nine
 * repos (orangecat alone carried four, and its ADR to unify them sat
 * "Proposed" for seven months while the count doubled). What actually varied
 * was one thing — where the counts live — so that is the one injectable seam:
 *
 *   slidingWindow / fixedWindow  — the algorithms, pure over store + clock
 *   Store / MemoryStore          — the seam, with a BOUNDED default (one of
 *                                  the replaced implementations leaked memory
 *                                  via an unbounded Map keyed by stranger IPs)
 *   toHeaders / clientIp         — the HTTP edges everyone also rewrote
 *
 * Deliberately NOT included, per the fleet's extraction rules: no HTTP client,
 * no framework middleware, no Response construction. The package supplies the
 * decision; the app keeps its own conventions. And no LIMITS — how many
 * requests a login route allows is app semantics, asserted locally, exactly
 * like which model id is a paid one (see ai-ration's modelCost).
 */

export {
  type LimitRule,
  type LimitResult,
  type Limiter,
  slidingWindow,
  fixedWindow,
} from "./limit.js";

export { type Store, type WindowState, MemoryStore } from "./store.js";

export { type HeadersLike, toHeaders, clientIp } from "./http.js";
