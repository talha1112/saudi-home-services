import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { assertOwnerOrAdmin } from '../../common/auth/ownership.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireApprovedWorker } from '../../common/decorators/approved-worker.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { Role } from '../../generated/prisma/client.js';
import {
  AdminUserSummaryDto,
  CustomerProfileDto,
  UpdateCustomerProfileDto,
  WorkerJobsDto,
  WorkerProfileDto,
} from './profiles.dto.js';
import { ProfilesService } from './profiles.service.js';

@ApiTags('Customers')
@ApiBearerAuth()
@Roles(Role.CUSTOMER)
@Controller({ path: 'customers', version: '1' })
export class CustomersController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get('me')
  @ApiOperation({ summary: 'My customer profile' })
  @ApiOkResponse({ type: CustomerProfileDto })
  me(@CurrentUser() user: AuthenticatedUser): Promise<CustomerProfileDto> {
    return this.profiles.customerProfile(user.id);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Set my name' })
  @ApiOkResponse({ type: CustomerProfileDto })
  updateMe(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateCustomerProfileDto): Promise<CustomerProfileDto> {
    return this.profiles.updateCustomerName(user.id, dto.fullName);
  }

  @Roles(Role.CUSTOMER, Role.ADMIN)
  @Get(':userId')
  @ApiOperation({ summary: 'A customer profile (the customer themself, or an admin)' })
  @ApiOkResponse({ type: CustomerProfileDto })
  byId(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<CustomerProfileDto> {
    assertOwnerOrAdmin(user, userId);
    return this.profiles.customerProfile(userId);
  }
}

@ApiTags('Workers')
@ApiBearerAuth()
@Roles(Role.WORKER)
@Controller({ path: 'workers', version: '1' })
export class WorkersController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get('me')
  @ApiOperation({ summary: 'My worker profile (available while verification is pending)' })
  @ApiOkResponse({ type: WorkerProfileDto })
  me(@CurrentUser() user: AuthenticatedUser): Promise<WorkerProfileDto> {
    return this.profiles.workerProfile(user.id);
  }

  @RequireApprovedWorker()
  @Get('me/jobs')
  @ApiOperation({
    summary: 'My jobs (approved workers only)',
    description: 'Stand-in for the job operations added with bookings; demonstrates the approval gate.',
  })
  @ApiOkResponse({ type: WorkerJobsDto })
  async jobs(): Promise<WorkerJobsDto> {
    return { items: [] };
  }

  @Roles(Role.WORKER, Role.ADMIN)
  @Get(':userId')
  @ApiOperation({ summary: 'A worker profile (the worker themself, or an admin)' })
  @ApiOkResponse({ type: WorkerProfileDto })
  byId(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<WorkerProfileDto> {
    assertOwnerOrAdmin(user, userId);
    return this.profiles.workerProfile(userId);
  }
}

@ApiTags('Admin')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/users', version: '1' })
export class AdminUsersController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get(':userId')
  @ApiOperation({ summary: 'Look up any user (admin only)' })
  @ApiOkResponse({ type: AdminUserSummaryDto })
  byId(@Param('userId', new ParseUUIDPipe()) userId: string): Promise<AdminUserSummaryDto> {
    return this.profiles.adminUserSummary(userId);
  }
}
