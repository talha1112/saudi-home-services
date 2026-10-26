import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsISO8601, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PageQueryDto, toPage } from '../../common/pagination/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Role, UserStatus } from '../../generated/prisma/client.js';
import { clientMeta } from '../auth/auth.controller.js';
import { AdminUsersService } from './admin-users.service.js';

const uuid = () => new ParseUUIDPipe();
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class AdminUsersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: [Role.CUSTOMER, Role.WORKER], description: 'Administrator accounts are never listed here' })
  @IsOptional()
  @IsIn([Role.CUSTOMER, Role.WORKER])
  role?: Role;

  @ApiPropertyOptional({ enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiPropertyOptional({ description: 'Part of a phone number, e-mail or name (2-60 characters)' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  q?: string;
}

export class AccountDecisionDto {
  @ApiProperty({ description: 'Why. Required, kept with the account and in the audit trail.', minLength: 3, maxLength: 500 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class AuditLogsQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() actorUserId?: string;
  @ApiPropertyOptional({ example: 'user.suspended' }) @IsOptional() @IsString() @MaxLength(100) action?: string;
  @ApiPropertyOptional({ example: 'booking' }) @IsOptional() @IsString() @MaxLength(60) entityType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) entityId?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true }) to?: string;
}

/**
 * Customer and worker account administration. There is one administrator role: every route here is ADMIN-only,
 * the services re-check the target's state, and every decision is audited with the reason.
 */
@ApiTags('Admin users')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/users', version: '1' })
export class AdminAccountsController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @ApiOperation({ summary: 'Customers and workers (redacted: masked phone and e-mail, no documents). Filters: role, status, q.' })
  list(@Query() q: AdminUsersQueryDto) {
    return this.users.list(q);
  }

  @Get(':userId/overview')
  @ApiOperation({ summary: 'One account with worker status, booking counts and recent booking summaries (no identity documents)' })
  overview(@Param('userId', uuid()) userId: string) {
    return this.users.overview(userId);
  }

  @Post(':userId/suspend')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'admin-account-decision', limit: 60, windowSeconds: 600 })
  @ApiOperation({ summary: 'Suspend an active account (reversible). Sessions and live sockets end at once; existing bookings are left untouched.' })
  suspend(@CurrentUser() admin: AuthenticatedUser, @Param('userId', uuid()) userId: string, @Body() dto: AccountDecisionDto, @Req() req: Request) {
    return this.users.suspend(admin.id, userId, dto.reason, clientMeta(req));
  }

  @Post(':userId/reactivate')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'admin-account-decision', limit: 60, windowSeconds: 600 })
  @ApiOperation({ summary: 'Reactivate a suspended account' })
  reactivate(@CurrentUser() admin: AuthenticatedUser, @Param('userId', uuid()) userId: string, @Body() dto: AccountDecisionDto, @Req() req: Request) {
    return this.users.reactivate(admin.id, userId, dto.reason, clientMeta(req));
  }
}

@ApiTags('Admin audit')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/audit-logs', version: '1' })
export class AdminAuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'The audit trail (read-only). Sensitive values were redacted when written.' })
  async list(@Query() q: AuditLogsQueryDto) {
    const where = {
      ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: q.skip, take: q.limit }),
      this.prisma.auditLog.count({ where }),
    ]);
    return toPage(
      rows.map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString(), actorUserId: r.actorUserId, action: r.action, entityType: r.entityType, entityId: r.entityId, metadata: r.metadata })),
      total,
      q,
    );
  }
}
