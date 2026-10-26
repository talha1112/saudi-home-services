import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { AdminUsersService } from './admin-users.service.js';
import { AdminAccountsController, AdminAuditController } from './admin.controllers.js';

/** Administrator tooling that does not belong to a single domain module: account administration and the audit trail viewer. */
@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [AdminAccountsController, AdminAuditController],
  providers: [AdminUsersService],
})
export class AdminModule {}
