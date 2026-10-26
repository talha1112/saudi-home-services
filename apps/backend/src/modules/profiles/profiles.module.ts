import { Module } from '@nestjs/common';
import { AdminUsersController, CustomersController, WorkersController } from './profiles.controllers.js';
import { ProfilesService } from './profiles.service.js';

@Module({
  controllers: [CustomersController, WorkersController, AdminUsersController],
  providers: [ProfilesService],
})
export class ProfilesModule {}
