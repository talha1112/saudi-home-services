import type { Redis } from 'ioredis';

/**
 * Closes a Redis connection without ever hanging shutdown: QUIT is polite, but on a connection that is
 * currently down ioredis would wait for it to come back, so after a short grace period it is cut.
 */
export async function quitQuietly(client: Redis, graceMs = 1000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.quit(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('quit timeout')), graceMs);
      }),
    ]);
  } catch {
    client.disconnect();
  } finally {
    clearTimeout(timer);
  }
}
