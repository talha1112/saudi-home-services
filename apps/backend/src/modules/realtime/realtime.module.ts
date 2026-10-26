import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { BookingAccessService } from './booking-access.service.js';
import { BookingEventPublisher } from './booking-event-publisher.js';
import { ChatService } from './chat/chat.service.js';
import { JobsService } from './jobs/jobs.service.js';
import { OutboxDispatcherService } from './jobs/outbox-dispatcher.service.js';
import { LocationService } from './location/location.service.js';
import { RealtimeEmitter } from './realtime-emitter.js';
import { BookingChatController, BookingLocationController, WorkerLocationController } from './realtime.controllers.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { SocketEmitter } from './socket-emitter.js';

/**
 * Phase 7: Socket.IO gateway, booking chat, live worker position, the transactional outbox
 * dispatcher and the BullMQ job runner. Documented in docs/REALTIME.md.
 */
@Module({
  imports: [AuthModule, NotificationsModule, StorageModule],
  controllers: [BookingChatController, BookingLocationController, WorkerLocationController],
  providers: [
    BookingAccessService,
    LocationService,
    ChatService,
    SocketEmitter,
    { provide: RealtimeEmitter, useExisting: SocketEmitter },
    RealtimeGateway,
    BookingEventPublisher,
    OutboxDispatcherService,
    JobsService,
  ],
  exports: [JobsService, OutboxDispatcherService, RealtimeGateway],
})
export class RealtimeModule {}
