/**
 * The few Redis operations the auth layer needs. Abstract so tests can swap in
 * an in-memory implementation and so Redis stays an implementation detail.
 * Everything stored here is temporary by design.
 */
export abstract class KeyValueStore {
  abstract get(key: string): Promise<string | null>;
  abstract set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Sets the key only if it does not exist. Returns whether it was set. */
  abstract setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /** Atomically reads and deletes, so a one-time value can be consumed exactly once. */
  abstract take(key: string): Promise<string | null>;
  abstract del(...keys: string[]): Promise<void>;
  /** Adds one to a counter; the expiry is set when the counter is created. Returns the new value. */
  abstract increment(key: string, ttlSeconds: number): Promise<number>;
  /** Seconds left before the key expires; -1 when it does not exist or never expires. */
  abstract ttl(key: string): Promise<number>;
  /** Up to `max` keys starting with `prefix` (a bounded, non-blocking scan; order is unspecified). */
  abstract scan(prefix: string, max: number): Promise<string[]>;
}
