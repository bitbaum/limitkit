/**
 * Where the counts live — the ONE thing the fleet's implementations genuinely
 * disagreed on, so it is the one thing left injectable.
 *
 * Of the twelve implementations this package replaces, eleven kept counts in
 * process memory and one (orangecat) in Upstash Redis. Everything around the
 * store — the window arithmetic, the refusal shape, the headers — was the same
 * idea written twelve slightly different ways. So the algorithm is fixed and
 * the store is a seam: an app that outgrows one process implements these two
 * methods over Redis/Postgres and changes nothing else.
 *
 * The store speaks in WINDOWS, not in "check" calls, so a remote
 * implementation is one round trip: read-modify-write of a single small value
 * under a key. No store method ever decides anything — deciding is the
 * algorithm's job, and keeping the store dumb is what makes an adapter a
 * dozen lines instead of a re-implementation.
 */

/** One key's state: hit timestamps (ms) inside the current horizon. */
export type WindowState = {
  /** Timestamps of counted hits, milliseconds. The algorithm prunes; the
   *  store just holds. */
  hits: number[];
};

export interface Store {
  /** The state for `key`, or undefined if none is held. */
  get(key: string): WindowState | undefined;
  /** Replace the state for `key`. An empty `hits` MAY be dropped entirely. */
  set(key: string, state: WindowState): void;
}

/**
 * The default store: in-process, and BOUNDED.
 *
 * Bounded is the point, not an optimisation. One of the twelve replaced
 * implementations kept a bare `Map` that only ever grew — every distinct key
 * (an IP, in practice) left an entry forever, which is a slow memory leak fed
 * by strangers. Two others solved it independently (a prune pass, an LRU).
 * This store evicts the oldest-touched key past `maxKeys`, so the failure mode
 * is "a very old bucket forgets", never "the process grows without bound".
 *
 * Scope, stated plainly: per-process. Behind N workers each holds its own
 * counts and the effective limit multiplies by N. That is acceptable for
 * blunting scripted abuse (what every replaced implementation was actually
 * for) and wrong for billing enforcement — for that, implement `Store` over
 * something shared.
 */
export class MemoryStore implements Store {
  private map = new Map<string, WindowState>();

  constructor(private maxKeys = 5_000) {}

  get(key: string): WindowState | undefined {
    const state = this.map.get(key);
    if (state) {
      // Refresh recency so eviction tracks use, not insertion order.
      this.map.delete(key);
      this.map.set(key, state);
    }
    return state;
  }

  set(key: string, state: WindowState): void {
    if (state.hits.length === 0) {
      this.map.delete(key);
      return;
    }
    this.map.delete(key);
    this.map.set(key, state);
    // Map iteration order is insertion order, so the first key is the
    // least-recently-touched — evicting it is LRU without a dependency.
    while (this.map.size > this.maxKeys) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** How many keys are currently held. Exposed for tests and monitoring. */
  get size(): number {
    return this.map.size;
  }
}
