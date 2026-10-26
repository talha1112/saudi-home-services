import { Body, Controller, Get, HttpCode, HttpStatus, Module, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { Role } from '../../generated/prisma/client.js';
import { AuthModule } from '../auth/auth.module.js';
import { clientMeta } from '../auth/auth.controller.js';
import {
  AdminListDisputesQueryDto,
  AdminNoteDto,
  AssignDisputeDto,
  DisputeTextDto,
  EvidenceRefsDto,
  ListMyDisputesQueryDto,
  OpenDisputeDto,
  ResolveDisputeDto,
} from './disputes.dto.js';
import { DisputesService } from './disputes.service.js';

const uuid = () => new ParseUUIDPipe();

/** The two parties of a booking. Every route is scoped to disputes of bookings the caller takes part in; anything else is 404. */
@ApiTags('Disputes')
@ApiBearerAuth()
@Roles(Role.CUSTOMER, Role.WORKER)
@Controller({ path: 'disputes', version: '1' })
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Post()
  @RateLimit({ name: 'dispute-open', limit: 20, windowSeconds: 3600 })
  @ApiOperation({ summary: 'Open a dispute about one of my bookings (customer, or the assigned worker)', description: 'Evidence references EXISTING photos and chat messages of the same booking. One active dispute per booking.' })
  open(@CurrentUser() user: AuthenticatedUser, @Body() dto: OpenDisputeDto) {
    return this.disputes.open(user, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Disputes of my bookings, newest first' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() q: ListMyDisputesQueryDto) {
    return this.disputes.listMine(user, q, q.status);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One dispute: shared history and evidence. Internal notes are never included; the resolution appears once resolved.' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return this.disputes.getForUser(user, id);
  }

  @Post(':id/comments')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'dispute-write', limit: 60, windowSeconds: 3600 })
  @ApiOperation({ summary: 'Add a message while the dispute is active (answers a request for information)' })
  comment(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: DisputeTextDto) {
    return this.disputes.comment(user, id, dto.text);
  }

  @Post(':id/evidence')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'dispute-write', limit: 60, windowSeconds: 3600 })
  @ApiOperation({ summary: 'Attach more existing photos / chat messages of the booking while the dispute is active' })
  evidence(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: EvidenceRefsDto) {
    return this.disputes.addEvidence(user, id, dto);
  }

  @Post(':id/withdraw')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'dispute-write', limit: 60, windowSeconds: 3600 })
  @ApiOperation({ summary: 'Withdraw a dispute I opened, while nobody has started reviewing it' })
  withdraw(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid()) id: string) {
    return this.disputes.withdraw(user, id);
  }
}

/**
 * Administrator side. One administrator role exists, so every admin may handle every dispute; assignment is for
 * accountability, not for access control. Each decision needs a note and is written to the audit log.
 */
@ApiTags('Admin disputes')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/disputes', version: '1' })
export class AdminDisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Get()
  @ApiOperation({ summary: 'All disputes (filters: status, category, bookingId, openedById, assignedAdminId, financialFollowup, created range)' })
  list(@Query() q: AdminListDisputesQueryDto) {
    return this.disputes.adminList(q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Full dispute including internal notes, every history entry and the evidence' })
  get(@Param('id', uuid()) id: string) {
    return this.disputes.adminGet(id);
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign the dispute to an active administrator (default: me)' })
  assign(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: AssignDisputeDto, @Req() req: Request) {
    return this.disputes.adminAction(admin, id, 'assign', { adminId: dto.adminId }, clientMeta(req));
  }

  @Post(':id/start-review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'OPEN or AWAITING_INFO -> UNDER_REVIEW (assigns me when unassigned)' })
  startReview(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Req() req: Request) {
    return this.disputes.adminAction(admin, id, 'start_review', {}, clientMeta(req));
  }

  @Post(':id/request-info')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ask the participants for information (shown to them). -> AWAITING_INFO' })
  requestInfo(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: AdminNoteDto, @Req() req: Request) {
    return this.disputes.adminAction(admin, id, 'request_info', { note: dto.note }, clientMeta(req));
  }

  @Post(':id/internal-note')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add a note only administrators can see' })
  internalNote(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: AdminNoteDto, @Req() req: Request) {
    return this.disputes.adminAction(admin, id, 'internal_note', { note: dto.note }, clientMeta(req));
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'UNDER_REVIEW -> RESOLVED with a summary for the participants',
    description: 'Records a decision only. It does NOT refund, reverse a ledger entry, suspend anyone or change a booking or rating. financialFollowup=REQUESTED merely flags a money follow-up for a separate approved workflow.',
  })
  resolve(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: ResolveDisputeDto, @Req() req: Request) {
    return this.disputes.adminAction(admin, id, 'resolve', { resolve: dto }, clientMeta(req));
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'RESOLVED -> CLOSED (final)' })
  close(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: AdminNoteDto, @Req() req: Request) {
    return this.disputes.adminAction(admin, id, 'close', { note: dto.note }, clientMeta(req));
  }

  @Post(':id/reopen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'RESOLVED -> UNDER_REVIEW with a reason (auditable follow-up; CLOSED cannot be reopened)' })
  reopen(@CurrentUser() admin: AuthenticatedUser, @Param('id', uuid()) id: string, @Body() dto: AdminNoteDto, @Req() req: Request) {
    return this.disputes.adminAction(admin, id, 'reopen', { note: dto.note }, clientMeta(req));
  }
}

@Module({
  imports: [AuthModule],
  controllers: [DisputesController, AdminDisputesController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}
