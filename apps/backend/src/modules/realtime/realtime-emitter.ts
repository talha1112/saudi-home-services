/**
 * How services push something to the sockets in a room. Abstract so services do not depend on
 * Socket.IO and tests can capture what would have been sent. Implemented by RealtimeGateway.
 *
 * Emitting is best effort: a failure here never undoes durable state (messages and booking
 * changes are already committed); clients recover through REST / chat.sync.
 */
export abstract class RealtimeEmitter {
  /** Sends to every socket currently in the room (on every API instance when the Redis adapter is on). */
  abstract toRoom(room: string, event: string, payload: unknown): void;
  /** Removes every socket from the room (on every instance). */
  abstract emptyRoom(room: string): void;
}
