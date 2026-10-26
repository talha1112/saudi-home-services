import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PageQueryDto, toOptionalBoolean } from '../../common/pagination/pagination.js';
import { DevicePlatform, PushProviderName, Role } from '../../generated/prisma/client.js';
import { DeviceTokensService } from './device-tokens.service.js';
import { NotificationsService } from './notifications.service.js';

const uuid = () => new ParseUUIDPipe();

export class ListNotificationsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Only unread notifications' })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  unread?: boolean;

  @ApiPropertyOptional({ enum: ['ar', 'en'], description: 'Render in this language instead of the account preference' })
  @IsOptional()
  @IsIn(['ar', 'en', 'AR', 'EN'])
  locale?: string;
}

export class LocaleQueryDto {
  @ApiPropertyOptional({ enum: ['ar', 'en'] })
  @IsOptional()
  @IsIn(['ar', 'en', 'AR', 'EN'])
  locale?: string;
}

export class RegisterDeviceDto {
  @ApiProperty({ enum: DevicePlatform })
  @IsEnum(DevicePlatform)
  platform!: DevicePlatform;

  @ApiProperty({ enum: PushProviderName, description: 'ANDROID: FCM. IOS: APNS or FCM. HUAWEI: HMS.' })
  @IsEnum(PushProviderName)
  provider!: PushProviderName;

  @ApiProperty({ description: 'The push token issued by the vendor SDK on the device. Stored encrypted; never returned.' })
  @IsString()
  @Length(16, 4096)
  @Matches(/^\S+$/, { message: 'token must not contain whitespace' })
  token!: string;
}

/**
 * My notifications. Every query is scoped to the caller's own id taken from the token; a recipient id is never
 * accepted from the client, and another user's notification id is "not found".
 */
@ApiTags('Notifications')
@ApiBearerAuth()
@Roles(Role.CUSTOMER, Role.WORKER)
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'My notifications, newest first (title and body are rendered in my language)' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() q: ListNotificationsQueryDto) {
    return this.notifications.list(user.id, q, { unreadOnly: q.unread, locale: q.locale });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Number of unread notifications (for the badge)' })
  unread(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.unreadCount(user.id);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'notifications-read', limit: 60, windowSeconds: 600 })
  @ApiOperation({ summary: 'Mark all my notifications as read' })
  readAll(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllRead(user.id);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'notifications-read', limit: 60, windowSeconds: 600 })
  @ApiOperation({ summary: 'Mark one of my notifications as read (idempotent)' })
  read(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid()) id: string, @Query() q: LocaleQueryDto) {
    return this.notifications.markRead(user.id, id, q.locale);
  }
}

/**
 * Push-token registration contract for the mobile apps (backend only in this phase).
 * Answers 503 PUSH_NOT_CONFIGURED until the server has a DEVICE_TOKEN_ENCRYPTION_KEY.
 */
@ApiTags('Devices')
@ApiBearerAuth()
@Roles(Role.CUSTOMER, Role.WORKER)
@Controller({ path: 'devices', version: '1' })
export class DevicesController {
  constructor(private readonly devices: DeviceTokensService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'devices-register', limit: 30, windowSeconds: 600 })
  @ApiOperation({ summary: 'Register (or refresh) this device for push notifications', description: 'Idempotent for the same token. A token already registered by another account moves to the caller.' })
  register(@CurrentUser() user: AuthenticatedUser, @Body() dto: RegisterDeviceDto) {
    return this.devices.register(user, dto);
  }

  @Get()
  @ApiOperation({ summary: 'My registered devices (no tokens are ever returned)' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.devices.list(user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'devices-revoke', limit: 60, windowSeconds: 600 })
  @ApiOperation({ summary: 'Stop push notifications to one of my devices (call on sign-out)' })
  async revoke(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid()) id: string): Promise<void> {
    await this.devices.revoke(user.id, id);
  }
}
