import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { ApiError, badRequest, unauthorized, unavailable } from '../../common/errors/api-error.js';
import { validatePayload } from '../../common/validation/validate-payload.js';
import { APP_CONFIG, type AppConfig, type RealtimeConfig } from '../../config/app.config.js';
import { KeyValueStore } from '../../database/key-value.store.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Role } from '../../generated/prisma/client.js';
import { AccessAuthenticator } from '../auth/access-authenticator.service.js';
import { BookingAccessService } from './booking-access.service.js';
import { SocketReceiptDto, SocketSendMessageDto, SocketSyncDto } from './chat/chat.dto.js';
import { ChatService } from './chat/chat.service.js';
import { BookingIdDto, LocationPublishDto } from './location/location.dto.js';
import { LocationService } from './location/location.service.js';
import {
  CLIENT_EVENTS,
  KEYS,
  REALTIME_NAMESPACE,
  SERVER_EVENTS,
  bookingCustomerRoom,
  bookingRoom,
  locationRoom,
} from './realtime.constants.js';
import { SocketEmitter } from './socket-emitter.js';

interface SocketData {
  user: AuthenticatedUser;
  claims: { userId: string; sessionId: string; role: Role };
  expiresAtMs: number;
  lastCheckedAt: number;
  bucket: { count: number; resetAt: number };
  strikes: number;
}
type Sock = Socket & { data: SocketData };
type Ack = (response: unknown) => void;

/** Errors after which the connection itself is no longer valid (the account or session is gone). */
const FATAL_CODES = new Set(['SESSION_REVOKED', 'ACCOUNT_NOT_ACTIVE', 'INSUFFICIENT_ROLE', 'TOKEN_INVALID']);
/** Only high-frequency events (position updates) may reuse a session check this recent; every other event re-reads the session. Every booking check is always live. */
const REVALIDATE_CACHE_MS = 5000;
const EVENT_BURST = 60;
const EVENT_WINDOW_MS = 10_000;
const MAX_ROOMS_PER_SOCKET = 20;
const MAX_TOKEN_LENGTH = 4096;

const bookingIdOf = (room: string) => /^booking:([0-9a-f-]{36})(?::|$)/i.exec(room)?.[1];

/**
 * The Socket.IO entry point (namespace /realtime). The full contract is in docs/REALTIME.md.
 *
 * Security model:
 *  - Connection: an access token (handshake `auth.token`, or an Authorization header for non-browser
 *    clients; never the URL) is verified exactly like an HTTP request: signature, expiry, session
 *    still active, account ACTIVE, role still held. Anything else is refused before the socket exists.
 *  - Identity comes from the token only. No payload field is ever read as a user id, role, or status.
 *  - Every room join and every sensitive event re-reads the booking from PostgreSQL and re-checks
 *    participation (customer / assigned approved worker). A background sweep also re-validates the
 *    session and every booking room, so revoked access ends without waiting for the token to expire.
 *  - A token that expires keeps the socket for a short grace period; the app sends `auth.refresh`
 *    with a new token of the SAME session, otherwise the socket is closed.
 *  - Payloads are validated with the same rules as REST; per-socket flood control; no tokens,
 *    message text or coordinates in logs.
 */
@Injectable()
@WebSocketGateway({ namespace: REALTIME_NAMESPACE })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly cfg: RealtimeConfig;
  private readonly trustProxyHops: number;
  private readonly byUser = new Map<string, Set<string>>();
  private readonly timers = new Map<string, { expiry?: NodeJS.Timeout; sweep?: NodeJS.Timeout }>();

  @WebSocketServer() private server!: Namespace;

  constructor(
    config: ConfigService,
    private readonly authenticator: AccessAuthenticator,
    private readonly access: BookingAccessService,
    private readonly chat: ChatService,
    private readonly location: LocationService,
    private readonly emitter: SocketEmitter,
    private readonly store: KeyValueStore,
    private readonly prisma: PrismaService,
  ) {
    const app = config.getOrThrow<AppConfig>(APP_CONFIG);
    this.cfg = app.realtime;
    this.trustProxyHops = app.trustProxyHops;
  }

  afterInit(server: Namespace): void {
    this.server = server;
    this.emitter.attach(server);
    server.use((socket, next) => {
      this.authenticateHandshake(socket)
        .then(() => next())
        .catch((err: unknown) => next(this.handshakeError(err)));
    });
    this.logger.log(`Realtime namespace ${REALTIME_NAMESPACE} ready`);
  }

  handleConnection(client: Socket): void {
    const socket = client as Sock;
    const { user } = socket.data;

    // Cap per account on this instance: the oldest connection is closed.
    const set = this.byUser.get(user.id) ?? new Set<string>();
    set.add(socket.id);
    this.byUser.set(user.id, set);
    if (set.size > this.cfg.maxSocketsPerUser) {
      const oldest = set.values().next().value as string;
      this.server.sockets.get(oldest)?.emit(SERVER_EVENTS.sessionEnding, { v: 1, reason: 'TOO_MANY_CONNECTIONS' });
      this.server.sockets.get(oldest)?.disconnect(true);
    }

    this.armExpiry(socket);
    const sweep = setInterval(() => void this.sweep(socket), this.cfg.revalidateSeconds * 1000);
    sweep.unref();
    this.timers.set(socket.id, { ...this.timers.get(socket.id), sweep });

    this.on(socket, CLIENT_EVENTS.authRefresh, async (raw) => this.refresh(socket, raw), { allowExpired: true });
    this.on(socket, CLIENT_EVENTS.bookingJoin, async (raw, u) => this.join(socket, u, validatePayload(BookingIdDto, raw).bookingId));
    this.on(socket, CLIENT_EVENTS.bookingLeave, async (raw) => {
      const { bookingId } = validatePayload(BookingIdDto, raw);
      for (const room of [bookingRoom(bookingId), bookingCustomerRoom(bookingId), locationRoom(bookingId)]) void socket.leave(room);
      return { bookingId };
    });
    this.on(socket, CLIENT_EVENTS.chatSend, async (raw, u) => {
      const dto = validatePayload(SocketSendMessageDto, raw);
      return this.chat.send(u, dto.bookingId, dto);
    });
    this.on(socket, CLIENT_EVENTS.chatSync, async (raw, u) => {
      const dto = validatePayload(SocketSyncDto, raw);
      return this.chat.list(u, dto.bookingId, dto);
    });
    this.on(socket, CLIENT_EVENTS.chatReceipt, async (raw, u) => {
      const dto = validatePayload(SocketReceiptDto, raw);
      return this.chat.receipt(u, dto.bookingId, dto);
    });
    this.on(socket, CLIENT_EVENTS.locationPublish, async (raw, u) => this.location.publish(u, validatePayload(LocationPublishDto, raw)), { cacheSession: true });
    this.on(socket, CLIENT_EVENTS.locationSubscribe, async (raw, u) => {
      const { bookingId } = validatePayload(BookingIdDto, raw);
      const latest = await this.location.authorizeSubscription(u, bookingId);
      this.assertRoomBudget(socket);
      await socket.join(locationRoom(bookingId));
      return { bookingId, latest };
    });
    this.on(socket, CLIENT_EVENTS.locationUnsubscribe, async (raw) => {
      const { bookingId } = validatePayload(BookingIdDto, raw);
      await socket.leave(locationRoom(bookingId));
      return { bookingId };
    });
  }

  handleDisconnect(client: Socket): void {
    // A disconnect says nothing about the booking: no state changes, no position is deleted (it expires by itself).
    const timers = this.timers.get(client.id);
    if (timers) {
      clearTimeout(timers.expiry);
      clearInterval(timers.sweep);
      this.timers.delete(client.id);
    }
    const userId = (client as Sock).data?.user?.id;
    if (userId) {
      const set = this.byUser.get(userId);
      set?.delete(client.id);
      if (set?.size === 0) this.byUser.delete(userId);
    }
  }

  onModuleDestroy(): void {
    for (const t of this.timers.values()) {
      clearTimeout(t.expiry);
      clearInterval(t.sweep);
    }
    this.timers.clear();
  }

  /**
   * Closes every open socket of one account on every instance (used when an administrator suspends it).
   * Without the Redis adapter this reaches the sockets of this instance only; the revalidation sweep
   * closes the rest within REALTIME_REVALIDATE_SECONDS.
   */
  async endUserSessions(userId: string, reason: string): Promise<number> {
    const sockets = await this.server.fetchSockets();
    let closed = 0;
    for (const remote of sockets) {
      if ((remote.data as SocketData | undefined)?.user?.id !== userId) continue;
      remote.emit(SERVER_EVENTS.sessionEnding, { v: 1, reason });
      remote.disconnect(true);
      closed += 1;
    }
    return closed;
  }

  /**
   * After a booking changed: any socket in its rooms whose owner no longer participates (worker
   * suspended, unassigned...) is removed. Cluster-wide with the Redis adapter; best effort.
   */
  async recheckRoom(bookingId: string): Promise<void> {
    try {
      const sockets = await this.server.in(bookingRoom(bookingId)).fetchSockets();
      for (const remote of sockets) {
        const data = remote.data as SocketData | undefined;
        if (!data?.user) continue;
        try {
          await this.access.resolve(data.user, bookingId);
        } catch {
          for (const room of [bookingRoom(bookingId), bookingCustomerRoom(bookingId), locationRoom(bookingId)]) remote.leave(room);
          remote.emit(SERVER_EVENTS.accessRevoked, { v: 1, bookingId, reason: 'ACCESS_REVOKED' });
        }
      }
    } catch (err) {
      this.logger.warn(`Room re-check skipped: ${(err as Error).name}`);
    }
  }

  // --------------------------------------------------------------------------------------------
  // Handshake
  // --------------------------------------------------------------------------------------------

  private async authenticateHandshake(socket: Socket): Promise<void> {
    if (!this.cfg.enabled) throw unavailable('REALTIME_DISABLED', 'Realtime updates are switched off');
    await this.limitConnectionAttempts(socket);
    const token = this.tokenFrom(socket);
    if (!token) throw unauthorized('AUTH_REQUIRED', 'Authentication is required');
    const { user, expiresAtMs } = await this.authenticator.authenticate(token);
    if (user.mustChangePassword) throw new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'You must change your password before continuing');
    socket.data = {
      user,
      claims: { userId: user.id, sessionId: user.sessionId, role: user.role },
      expiresAtMs,
      lastCheckedAt: Date.now(),
      bucket: { count: 0, resetAt: Date.now() + EVENT_WINDOW_MS },
      strikes: 0,
    } satisfies SocketData;
  }

  private tokenFrom(socket: Socket): string | null {
    const auth = socket.handshake.auth as Record<string, unknown> | undefined;
    const candidate = typeof auth?.['token'] === 'string' ? (auth['token'] as string) : undefined;
    const header = socket.handshake.headers['authorization'];
    const fromHeader = (Array.isArray(header) ? header[0] : header)?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const token = candidate ?? fromHeader;
    return token && token.length <= MAX_TOKEN_LENGTH ? token : null;
  }

  /** Cheap flood control before any token work. Fails open if the shared store is down (the token check is still required). */
  private async limitConnectionAttempts(socket: Socket): Promise<void> {
    const ip = this.clientIp(socket);
    try {
      const count = await this.store.increment(KEYS.wsConnectRate(ip), 60);
      if (count > 60) throw new ApiError(429, 'RATE_LIMITED', 'Too many connection attempts, try again later');
    } catch (err) {
      if (err instanceof ApiError && err.getStatus() === 429) throw err;
    }
  }

  private clientIp(socket: Socket): string {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (this.trustProxyHops > 0 && typeof forwarded === 'string') {
      const parts = forwarded.split(',').map((p) => p.trim()).filter(Boolean);
      const ip = parts[parts.length - this.trustProxyHops];
      if (ip) return ip;
    }
    return socket.handshake.address || 'unknown';
  }

  private handshakeError(err: unknown): Error {
    const info = this.errorInfo(err, 'handshake');
    const e = new Error(info.code) as Error & { data: unknown };
    e.data = info;
    return e;
  }

  // --------------------------------------------------------------------------------------------
  // Event plumbing
  // --------------------------------------------------------------------------------------------

  /** Registers one client event: flood control, token/session liveness, validation errors and failures all become a uniform acknowledgement. */
  private on(socket: Sock, event: string, handler: (raw: unknown, user: AuthenticatedUser) => Promise<unknown>, opts: { allowExpired?: boolean; cacheSession?: boolean } = {}): void {
    socket.on(event, (first: unknown, second?: Ack) => {
      // `emit(event, callback)` (no payload): the callback arrives first.
      const raw = typeof first === 'function' ? undefined : first;
      const ack = typeof first === 'function' ? (first as Ack) : second;
      const reply: Ack = typeof ack === 'function' ? ack : () => undefined;
      void (async () => {
        try {
          this.floodControl(socket);
          await this.ensureLive(socket, opts.allowExpired === true, opts.cacheSession === true);
          const data = await handler(raw, socket.data.user);
          reply({ ok: true, data });
        } catch (err) {
          const info = this.errorInfo(err, event, socket.data?.user?.id);
          reply({ ok: false, error: info });
          if (FATAL_CODES.has(info.code)) this.endSocket(socket, info.code);
        }
      })();
    });
  }

  private floodControl(socket: Sock): void {
    const now = Date.now();
    const b = socket.data.bucket;
    if (b.resetAt <= now) {
      b.count = 0;
      b.resetAt = now + EVENT_WINDOW_MS;
    }
    if (++b.count > EVENT_BURST) {
      if (++socket.data.strikes >= 5) this.endSocket(socket, 'RATE_LIMITED');
      throw new ApiError(429, 'RATE_LIMITED', 'Too many events, slow down', { retryAfterSeconds: Math.ceil((b.resetAt - now) / 1000) });
    }
  }

  /** Token not past expiry, and the session/account re-read from the database (position updates may reuse a check from the last few seconds). */
  private async ensureLive(socket: Sock, allowExpired: boolean, cacheSession: boolean): Promise<void> {
    const d = socket.data;
    const now = Date.now();
    if (!allowExpired && now >= d.expiresAtMs) throw unauthorized('TOKEN_EXPIRED', 'The access token has expired. Send auth.refresh with a new token');
    if (!cacheSession || now - d.lastCheckedAt > REVALIDATE_CACHE_MS) {
      d.user = await this.authenticator.revalidate(d.claims);
      d.lastCheckedAt = now;
    }
  }

  private async refresh(socket: Sock, raw: unknown): Promise<{ expiresAt: string }> {
    const token = typeof (raw as { token?: unknown } | null)?.token === 'string' ? (raw as { token: string }).token : '';
    if (!token || token.length > MAX_TOKEN_LENGTH) throw badRequest('VALIDATION_FAILED', 'token is required');
    const { user, expiresAtMs } = await this.authenticator.authenticate(token);
    // A refreshed token must belong to the very same session: this can never switch the socket to another identity.
    if (user.id !== socket.data.claims.userId || user.sessionId !== socket.data.claims.sessionId || user.role !== socket.data.claims.role) {
      throw new ApiError(403, 'TOKEN_MISMATCH', 'The new token does not belong to this connection');
    }
    socket.data.user = user;
    socket.data.expiresAtMs = expiresAtMs;
    socket.data.lastCheckedAt = Date.now();
    this.armExpiry(socket);
    return { expiresAt: new Date(expiresAtMs).toISOString() };
  }

  private armExpiry(socket: Sock): void {
    const timers = this.timers.get(socket.id) ?? {};
    clearTimeout(timers.expiry);
    const delay = Math.max(0, socket.data.expiresAtMs + this.cfg.tokenGraceSeconds * 1000 - Date.now());
    timers.expiry = setTimeout(() => this.endSocket(socket, 'TOKEN_EXPIRED'), delay);
    timers.expiry.unref();
    this.timers.set(socket.id, timers);
  }

  private endSocket(socket: Sock, reason: string): void {
    socket.emit(SERVER_EVENTS.sessionEnding, { v: 1, reason });
    // Let the acknowledgement and the notice leave first.
    setTimeout(() => socket.disconnect(true), 50).unref();
  }

  /** Periodic re-validation: session, account, and participation in every booking room this socket sits in. */
  private async sweep(socket: Sock): Promise<void> {
    if (!socket.connected) return;
    try {
      socket.data.user = await this.authenticator.revalidate(socket.data.claims);
      socket.data.lastCheckedAt = Date.now();
    } catch (err) {
      const info = this.errorInfo(err, 'sweep');
      if (FATAL_CODES.has(info.code)) this.endSocket(socket, info.code);
      return; // a database hiccup is retried at the next sweep
    }
    const ids = new Set<string>();
    for (const room of socket.rooms) {
      const id = bookingIdOf(room);
      if (id) ids.add(id);
    }
    for (const bookingId of ids) {
      try {
        await this.access.resolve(socket.data.user, bookingId);
      } catch (err) {
        if (err instanceof ApiError) {
          for (const room of [bookingRoom(bookingId), bookingCustomerRoom(bookingId), locationRoom(bookingId)]) void socket.leave(room);
          socket.emit(SERVER_EVENTS.accessRevoked, { v: 1, bookingId, reason: 'ACCESS_REVOKED' });
        }
      }
    }
  }

  private assertRoomBudget(socket: Sock): void {
    if (socket.rooms.size > MAX_ROOMS_PER_SOCKET) throw new ApiError(429, 'TOO_MANY_ROOMS', 'This connection has joined too many bookings');
  }

  private async join(socket: Sock, user: AuthenticatedUser, bookingId: string) {
    const { side, booking } = await this.access.resolve(user, bookingId);
    this.assertRoomBudget(socket);
    await socket.join(bookingRoom(bookingId));
    if (side === 'CUSTOMER') await socket.join(bookingCustomerRoom(bookingId));
    const last = await this.prisma.chatMessage.aggregate({ where: { bookingId }, _max: { seq: true } });
    return { bookingId, side, status: booking.status, chat: { lastSeq: last._max.seq ?? 0 } };
  }

  /** Uniform error shape for acknowledgements and handshake errors. Unexpected errors are logged by class only. */
  private errorInfo(err: unknown, where: string, userId?: string): { code: string; message: string; details?: unknown; retryAfterSeconds?: number } {
    if (err instanceof ApiError) {
      const body = err.getResponse() as { message?: string; details?: unknown; retryAfterSeconds?: number };
      return {
        code: err.code,
        message: body.message ?? err.message,
        ...(body.details !== undefined ? { details: body.details } : {}),
        ...(body.retryAfterSeconds !== undefined ? { retryAfterSeconds: body.retryAfterSeconds } : {}),
      };
    }
    this.logger.error(`Unexpected error in "${where}"${userId ? ` for user ${userId}` : ''}: ${(err as Error)?.name ?? 'unknown'}`);
    return { code: 'INTERNAL_ERROR', message: 'Something went wrong' };
  }
}
