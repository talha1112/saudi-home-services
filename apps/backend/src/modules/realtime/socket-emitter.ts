import { Injectable, Logger } from '@nestjs/common';
import type { Namespace } from 'socket.io';
import { RealtimeEmitter } from './realtime-emitter.js';

/** The Socket.IO-backed emitter. The gateway attaches the namespace once the server exists. */
@Injectable()
export class SocketEmitter extends RealtimeEmitter {
  private readonly logger = new Logger(SocketEmitter.name);
  private namespace?: Namespace;

  attach(namespace: Namespace): void {
    this.namespace = namespace;
  }

  /** The outbox dispatcher refuses to mark an event delivered while there is no socket server to deliver it. */
  isAttached(): boolean {
    return this.namespace !== undefined;
  }

  toRoom(room: string, event: string, payload: unknown): void {
    if (!this.namespace) {
      this.logger.warn(`Dropped "${event}": the realtime server is not running`);
      return;
    }
    try {
      this.namespace.to(room).emit(event, payload);
    } catch (err) {
      this.logger.warn(`Could not emit "${event}": ${(err as Error).name}`); // no payload: it may hold private text or coordinates
    }
  }

  /** Strict variant for the outbox: throws instead of dropping, so the event stays pending and is retried. */
  toRoomOrThrow(room: string, event: string, payload: unknown): void {
    if (!this.namespace) throw new Error('REALTIME_SERVER_NOT_RUNNING');
    this.namespace.to(room).emit(event, payload);
  }

  emptyRoom(room: string): void {
    if (!this.namespace) return;
    try {
      this.namespace.in(room).socketsLeave(room);
    } catch (err) {
      this.logger.warn(`Could not empty a room: ${(err as Error).name}`);
    }
  }
}
