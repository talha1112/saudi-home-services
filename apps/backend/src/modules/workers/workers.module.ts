import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { WorkerDiscoveryService } from './worker-discovery.service.js';
import { WorkerOnboardingService } from './worker-onboarding.service.js';
import { WorkerVerificationService } from './worker-verification.service.js';
import { AdminWorkersController, WorkerDiscoveryController, WorkerOnboardingController } from './workers.controllers.js';

/** Worker onboarding, admin verification and customer-facing discovery. */
@Module({
  imports: [AuthModule, StorageModule, NotificationsModule],
  controllers: [WorkerOnboardingController, WorkerDiscoveryController, AdminWorkersController],
  providers: [WorkerOnboardingService, WorkerVerificationService, WorkerDiscoveryService],
})
export class WorkersModule {}
