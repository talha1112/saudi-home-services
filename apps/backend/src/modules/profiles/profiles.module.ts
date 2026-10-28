import { Module } from '@nestjs/common';
import { AccountController, AdminUsersController, CustomersController, WorkersController } from './profiles.controllers.js';
import { ProfilesService } from './profiles.service.js';

@Module({
  controllers: [AccountController, CustomersController, WorkersController, AdminUsersController],
  providers: [ProfilesService],
})
export class ProfilesModule {}
