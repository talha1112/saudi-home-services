import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import type { AppConfig } from '../../config/app.config.js';
import { quitQuietly } from '../../database/quit-quietly.js';

/**
 * Creates the Socket.IO server with this project's settings: CORS from CORS_ORIGINS, a small
 * message size cap, and (optionally) the Redis adapter so several API instances share rooms.
 *
 * The Redis adapter uses two dedicated connections (publish / subscribe). They are separate from the
 * REST Redis client so a blocked subscriber can never stall rate limits or OTP checks. If Redis is
 * unreachable the server still starts and serves its local sockets; cross-instance delivery resumes
 * when Redis returns (connection problems are logged once per distinct error, never with the URL).
 */
export class RealtimeIoAdapter extends IoAdapter {
  private readonly log = new Logger(RealtimeIoAdapter.name);
  private readonly redisClients: Redis[] = [];

  constructor(app: INestApplicationContext, private readonly config: AppConfig) {
    super(app);
  }

  override createIOServer(port: number, options?: Partial<ServerOptions>): Server {
    const { realtime, corsOrigins } = this.config;
    const server: Server = super.createIOServer(port, {
      ...options,
      cors: { origin: corsOrigins.length > 0 ? corsOrigins : false },
      maxHttpBufferSize: realtime.maxMessageBytes,
      // Position / chat traffic is small and frequent; compression only adds CPU.
      perMessageDeflate: false,
      serveClient: false,
    } as ServerOptions);

    if (realtime.redisAdapter) {
      const pub = this.newClient();
      const sub = pub.duplicate();
      this.redisClients.push(sub);
      this.watch(sub);
      server.adapter(createAdapter(pub, sub, { key: `${realtime.jobs.queuePrefix}:sio` }));
      this.log.log('Socket.IO Redis adapter enabled');
    }
    return server;
  }

  override async dispose(): Promise<void> {
    await super.dispose();
    await Promise.all(this.redisClients.splice(0).map((c) => quitQuietly(c)));
  }

  private newClient(): Redis {
    const client = new Redis(this.config.redisUrl, { maxRetriesPerRequest: null, retryStrategy: (n) => Math.min(n * 200, 2000) });
    this.redisClients.push(client);
    this.watch(client);
    return client;
  }

  private lastError?: string;
  private watch(client: Redis): void {
    client.on('error', (err: Error) => {
      if (err.message !== this.lastError) {
        this.lastError = err.message;
        this.log.warn(`Socket.IO Redis adapter connection problem: ${err.message}`);
      }
    });
    client.on('ready', () => {
      this.lastError = undefined;
    });
  }
}
