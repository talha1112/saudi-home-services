import { KeyValueStore } from '../database/key-value.store.js';

/** Test double for Redis. Reads Date.now(), so jest fake timers drive expiry. */
export class MemoryKeyValueStore extends KeyValueStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  private live(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string) {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds: number) {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number) {
    if (this.live(key)) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async take(key: string) {
    const value = this.live(key)?.value ?? null;
    this.entries.delete(key);
    return value;
  }

  async del(...keys: string[]) {
    keys.forEach((k) => this.entries.delete(k));
  }

  async increment(key: string, ttlSeconds: number) {
    const entry = this.live(key);
    if (!entry) {
      await this.set(key, '1', ttlSeconds);
      return 1;
    }
    entry.value = String(Number(entry.value) + 1);
    return Number(entry.value);
  }

  async ttl(key: string) {
    const entry = this.live(key);
    return entry ? Math.ceil((entry.expiresAt - Date.now()) / 1000) : -1;
  }

  async scan(prefix: string, max: number) {
    return [...this.entries.keys()].filter((k) => k.startsWith(prefix) && this.live(k)).slice(0, max);
  }

  /** Test helper: drop every key with the prefix (e.g. to skip a resend cooldown). */
  deleteByPrefix(prefix: string) {
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.entries.delete(key);
  }
}
