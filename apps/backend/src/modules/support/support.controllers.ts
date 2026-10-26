import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { Role } from '../../generated/prisma/client.js';
import { clientMeta } from '../auth/auth.controller.js';
import {
  AdminReplyDto,
  AdminSupportThreadDetailDto,
  ListSupportThreadsQueryDto,
  PagedSupportThreadsDto,
  SendSupportMessageDto,
  SupportMessagesPageDto,
  SupportMessagesQueryDto,
} from './support.dto.js';
import { SupportService } from './support.service.js';

const uuid = () => new ParseUUIDPipe();

/**
 * The person's own support conversation. Customers and workers (including a worker whose application is not approved, suspended, or
 * rejected) can use it; nobody can read anyone else's.
 */
@ApiTags('Support')
@ApiBearerAuth()
@Roles(Role.CUSTOMER, Role.WORKER)
@Controller({ path: 'support/messages', version: '1' })
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  @ApiOperation({
    summary: 'My support conversation',
    description: 'Default: the latest page, oldest first. `afterSeq` returns what came after a known message (polling). An empty list means no conversation yet.',
  })
  @ApiOkResponse({ type: SupportMessagesPageDto })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: SupportMessagesQueryDto) {
    return this.support.list(user, query);
  }

  @Post()
  @RateLimit({ name: 'support-send', limit: 60, windowSeconds: 600 })
  @ApiOperation({
    summary: 'Write to support',
    description: '201 when stored, 200 with the original message when `clientMessageId` was already accepted (a safe retry). The first message starts the conversation.',
  })
  @ApiCreatedResponse({ type: Object })
  async send(@CurrentUser() user: AuthenticatedUser, @Body() dto: SendSupportMessageDto, @Res({ passthrough: true }) res: Response) {
    const { message, duplicate } = await this.support.send(user, dto);
    res.status(duplicate ? HttpStatus.OK : HttpStatus.CREATED);
    return { ...message, duplicate };
  }
}

@ApiTags('Admin support')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/support/threads', version: '1' })
export class AdminSupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  @ApiOperation({ summary: 'Support conversations (those waiting for an administrator first)' })
  @ApiOkResponse({ type: PagedSupportThreadsDto })
  list(@Query() q: ListSupportThreadsQueryDto) {
    return this.support.adminList(q);
  }

  @Get(':threadId')
  @ApiOperation({ summary: 'One conversation with who it is from (name, phone, and for a worker the application status)' })
  @ApiOkResponse({ type: AdminSupportThreadDetailDto })
  thread(@Param('threadId', uuid()) threadId: string, @Query() query: SupportMessagesQueryDto) {
    return this.support.adminThread(threadId, query);
  }

  @Post(':threadId/reply')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'support-admin-reply', limit: 300, windowSeconds: 600 })
  @ApiOperation({ summary: 'Reply (the conversation becomes ANSWERED; the person sees the reply in their app)' })
  @ApiOkResponse({ type: AdminSupportThreadDetailDto })
  reply(@CurrentUser() admin: AuthenticatedUser, @Param('threadId', uuid()) threadId: string, @Body() dto: AdminReplyDto, @Req() req: Request) {
    const meta = clientMeta(req);
    return this.support.adminReply(admin.id, threadId, dto, meta);
  }

  @Post(':threadId/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark the conversation resolved (a new message from the person reopens it)' })
  @ApiOkResponse({ type: AdminSupportThreadDetailDto })
  resolve(@CurrentUser() admin: AuthenticatedUser, @Param('threadId', uuid()) threadId: string, @Req() req: Request) {
    return this.support.adminSetStatus(admin.id, threadId, 'RESOLVED', clientMeta(req));
  }

  @Post(':threadId/reopen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reopen a resolved conversation' })
  @ApiOkResponse({ type: AdminSupportThreadDetailDto })
  reopen(@CurrentUser() admin: AuthenticatedUser, @Param('threadId', uuid()) threadId: string, @Req() req: Request) {
    return this.support.adminSetStatus(admin.id, threadId, 'OPEN', clientMeta(req));
  }
}
