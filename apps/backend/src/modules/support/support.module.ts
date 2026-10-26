import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AdminSupportController, SupportController } from './support.controllers.js';
import { SupportService } from './support.service.js';

/** Support conversations between customers / workers and the administrators. */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [SupportController, AdminSupportController],
  providers: [SupportService],
})
export class SupportModule {}
