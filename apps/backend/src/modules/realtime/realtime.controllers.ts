import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { Role } from '../../generated/prisma/client.js';
import { MessagesQueryDto, ReceiptDto, SendMessageDto } from './chat/chat.dto.js';
import { ChatService } from './chat/chat.service.js';
import { RequireApprovedWorker } from '../../common/decorators/approved-worker.decorator.js';
import { LocationReportDto } from './location/location.dto.js';
import { LocationService } from './location/location.service.js';

const uuid = () => new ParseUUIDPipe();

/**
 * Booking chat over REST. The same service backs the socket events; REST is the reliable path
 * (retries, reconnect recovery, history) and the sockets are the fast path.
 * Only the booking's customer and its assigned, approved worker may use these; everyone else gets 404.
 */
@ApiTags('Booking chat')
@ApiBearerAuth()
@Roles(Role.CUSTOMER, Role.WORKER)
@Controller({ path: 'bookings/:bookingId/messages', version: '1' })
export class BookingChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  @ApiOperation({
    summary: 'Chat history',
    description:
      'Default: the latest page, oldest first. `beforeSeq` scrolls back. `afterSeq` returns what came after a known message (reconnect recovery). Ordering is by the per-booking `seq`, which never changes.',
  })
  list(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) bookingId: string, @Query() query: MessagesQueryDto) {
    return this.chat.list(user, bookingId, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Send a message',
    description:
      '201 when stored, 200 with the original message when `clientMessageId` was already accepted (a safe retry). The sender and its role come from the token, never from the body.',
  })
  async send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('bookingId', uuid()) bookingId: string,
    @Body() dto: SendMessageDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { message, duplicate } = await this.chat.send(user, bookingId, dto);
    res.status(duplicate ? HttpStatus.OK : HttpStatus.CREATED);
    return { ...message, duplicate };
  }

  @Post('receipts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Report messages as delivered or read', description: 'Only moves forward. `upToSeq` cannot exceed the latest message.' })
  receipt(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) bookingId: string, @Body() dto: ReceiptDto) {
    return this.chat.receipt(user, bookingId, dto);
  }
}

/**
 * The assigned worker's phone reports its position here (the same rules as the socket event `location.publish`: assigned and approved
 * worker, booking CONFIRMED or IN_PROGRESS, plausibility and rate checks; nothing is stored in PostgreSQL).
 */
@ApiTags('Worker location')
@ApiBearerAuth()
@RequireApprovedWorker()
@Controller({ path: 'workers/me/bookings/:bookingId/location', version: '1' })
export class WorkerLocationController {
  constructor(private readonly location: LocationService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Share my position for this booking (409 LOCATION_SHARING_NOT_ACTIVE when sharing is not open)' })
  @ApiOkResponse({ description: 'When the reading was recorded and received' })
  publish(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) bookingId: string, @Body() dto: LocationReportDto) {
    return this.location.publish(user, { ...dto, bookingId });
  }
}

@ApiTags('Worker location')
@ApiBearerAuth()
@Roles(Role.CUSTOMER)
@Controller({ path: 'bookings/:bookingId/location', version: '1' })
export class BookingLocationController {
  constructor(private readonly location: LocationService) {}

  @Get()
  @ApiOperation({
    summary: "The assigned worker's latest shared position",
    description:
      'Only the booking customer. `available: false` when sharing is not active for the booking or no recent position exists; the server never invents coordinates. 503 when the position store is unreachable.',
  })
  @ApiOkResponse({ description: 'Latest position or an explicit "unavailable"' })
  read(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) bookingId: string) {
    return this.location.read(user, bookingId);
  }
}
