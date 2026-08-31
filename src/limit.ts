/**
 * The decision: may this key take another hit right now?
 *
 * Pure over its inputs — the store and the clock are arguments — for the same
 * reason ai-ration's fair-share is: the behaviour worth testing ("a full
 * window refuses with an honest retry time") must be provable without a
 * server, a database, or a real minute passing. Every replaced implementation
 * baked `Date.now()` in, so none of them could test the one thing they were
 * for without sleeping through it.
 *
 * Two window shapes, because the fleet genuinely used both and they refuse
 * differently:
 *
 *   FIXED    — N hits per aligned window; the whole allowance reappears when
 *              the window rolls. Cheaper (one counter), burstier at the edge:
 *              2N hits can land in moments around a boundary.
 *   SLIDING  — N hits per trailing window, measured from each hit. Smoother,
 *              costs the timestamps. This is what most of the fleet meant even
 *              when it implemented fixed.
 *
 * The refusal carries `retryAfterSeconds` computed from the actual state —
 * when the OLDEST counted hit ages out — not a guess. "Try again shortly" on
 * a window that will not open for an hour is the same lie the 429 classifier
 * in ai-ration exists to prevent, one layer down.
 */

import type { Store } from "./store.js";
import { MemoryStore } from "./store.js";

export type LimitRule = {
  /** Max hits inside the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

export type LimitResult = {
  allowed: boolean;
  /** The rule's ceiling, echoed for headers. */
  limit: number;
  /** Hits still available in this window (0 when refused). */
  remaining: number;
  /** Epoch ms when the window opens again (when the next hit would be allowed). */
  resetAt: number;
  /** Whole seconds until then; 0 when allowed. Never fabricated — derived
   *  from the oldest counted hit. */
  retryAfterSeconds: number;
};

/**
 * A limiter bound to one rule and one store.
 *
 * `check` counts the hit when allowed and counts NOTHING when refused: a
 * refused request must not extend its own punishment, or a steady attacker
 * locks a key shut forever and the legitimate user behind the same NAT never
 * gets back in.
 */
export type Limiter = {
  check(key: string, now?: number): LimitResult;
  /** Read-only view: what would happen, counting nothing either way. */
  peek(key: string, now?: number): LimitResult;
};

function decide(
  rule: LimitRule,
  hits: number[],
  now: number,
): { allowed: boolean; result: LimitResult } {
  const live = hits.filter((t) => t > now - rule.windowMs);
  const allowed = live.length < rule.limit;
  const oldest = live[0];
  const resetAt = live.length === 0 ? now : (oldest ?? now) + rule.windowMs;
  return {
    allowed,
    result: {
      allowed,
      limit: rule.limit,
      remaining: Math.max(0, rule.limit - live.length - (allowed ? 1 : 0)),
      resetAt,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1000)),
    },
  };
}

/**
 * Sliding window: N hits per trailing `windowMs`, measured from each hit.
 *
 * The default, because it is what nearly every replaced implementation was
 * reaching for: "no more than N in any M minutes", not "N per wall-clock
 * bucket".
 */
export function slidingWindow(rule: LimitRule, store: Store = new MemoryStore()): Limiter {
  return {
    check(key, now = Date.now()) {
      const state = store.get(key) ?? { hits: [] };
      const live = state.hits.filter((t) => t > now - rule.windowMs);
      const { allowed, result } = decide(rule, live, now);
      // Counted only when allowed; a refusal writes back only the prune, so a
      // hammered key still recovers the moment the attacker stops.
      store.set(key, { hits: allowed ? [...live, now] : live });
      return result;
    },
    peek(key, now = Date.now()) {
      const state = store.get(key) ?? { hits: [] };
      return decide(rule, state.hits, now).result;
    },
  };
}

/**
 * Fixed window: N hits per aligned `windowMs` bucket.
 *
 * Kept because three of the replaced implementations chose it deliberately
 * for cheapness, and because its edge-burst behaviour (up to 2N around a
 * boundary) is sometimes fine and sometimes the whole objection — the choice
 * should be named at the call site, not implied by whichever file got copied.
 *
 * Implemented on the same store contract: the bucket is represented as one
 * synthetic hit timestamp (the bucket start) repeated per hit, so a remote
 * Store needs no second schema.
 */
export function fixedWindow(rule: LimitRule, store: Store = new MemoryStore()): Limiter {
  const bucketStart = (now: number) => now - (now % rule.windowMs);
  return {
    check(key, now = Date.now()) {
      const start = bucketStart(now);
      const state = store.get(key) ?? { hits: [] };
      const live = state.hits.filter((t) => t === start);
      const allowed = live.length < rule.limit;
      store.set(key, { hits: allowed ? [...live, start] : live });
      const resetAt = start + rule.windowMs;
      return {
        allowed,
        limit: rule.limit,
        remaining: Math.max(0, rule.limit - live.length - (allowed ? 1 : 0)),
        resetAt,
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1000)),
      };
    },
    peek(key, now = Date.now()) {
      const start = bucketStart(now);
      const state = store.get(key) ?? { hits: [] };
      const live = state.hits.filter((t) => t === start);
      const allowed = live.length < rule.limit;
      const resetAt = start + rule.windowMs;
      return {
        allowed,
        limit: rule.limit,
        remaining: Math.max(0, rule.limit - live.length),
        resetAt,
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1000)),
      };
    },
  };
}
