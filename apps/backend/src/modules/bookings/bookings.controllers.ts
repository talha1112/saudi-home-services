import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { RequireApprovedWorker } from '../../common/decorators/approved-worker.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { Role } from '../../generated/prisma/client.js';
import { clientMeta } from '../auth/auth.controller.js';
import { BookingLifecycleService } from './booking-lifecycle.service.js';
import { BookingPhotosService } from './booking-photos.service.js';
import { BookingsQueryService } from './bookings-query.service.js';
import {
  AcceptQuoteDto,
  AdminBookingDetailDto,
  AdminCancelBookingDto,
  AdminListBookingsQueryDto,
  BookingDetailDto,
  BookingPhotoDto,
  CancelBookingDto,
  CreateBookingDto,
  CreateQuoteDto,
  ListBookingsQueryDto,
  ListMyQuotesQueryDto,
  ListQuotesQueryDto,
  ListRequestsQueryDto,
  PagedBookingsDto,
  PagedQuotesDto,
  PagedWorkerBookingsDto,
  PagedWorkerQuotesDto,
  PagedWorkerRequestsDto,
  PhotoDownloadDto,
  PhotoUploadDto,
  QuoteForWorkerDto,
  RegisterBookingPhotoDto,
  RequestQuoteChangeDto,
  UpdateQuoteDto,
  WorkerBookingDto,
  WorkerRequestDetailDto,
} from './dto/bookings.dto.js';
import { QuotesService } from './quotes.service.js';

const uuid = () => new ParseUUIDPipe();

// ===========================================================================
// Customer app
// ===========================================================================

@ApiTags('Customer bookings')
@ApiBearerAuth()
@Roles(Role.CUSTOMER)
@Controller({ path: 'bookings', version: '1' })
export class CustomerBookingsController {
  constructor(
    private readonly lifecycle: BookingLifecycleService,
    private readonly query: BookingsQueryService,
    private readonly photos: BookingPhotosService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Create a booking request',
    description: 'Describe the problem, place and preferred time. You do not pick a worker: eligible approved workers send quotes and you choose one.',
  })
  @ApiCreatedResponse({ type: BookingDetailDto })
  async create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateBookingDto) {
    const created = await this.lifecycle.create(user.id, dto);
    return this.query.detailForCustomer(user.id, created.id);
  }

  @Get()
  @ApiOperation({ summary: 'My bookings (filters: status, serviceId, cityId, createdFrom/To; sort)' })
  @ApiOkResponse({ type: PagedBookingsDto })
  list(@CurrentUser() user: AuthenticatedUser, @Query() q: ListBookingsQueryDto) {
    return this.query.listMine(user.id, q);
  }

  @Get(':bookingId')
  @ApiOperation({ summary: 'One of my bookings, with timeline, photos and the assigned worker' })
  @ApiOkResponse({ type: BookingDetailDto })
  detail(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) id: string) {
    return this.query.detailForCustomer(user.id, id);
  }

  @Post(':bookingId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel my booking (not possible once the work has started)' })
  @ApiOkResponse({ type: BookingDetailDto })
  async cancel(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) id: string, @Body() dto: CancelBookingDto, @Req() req: Request) {
    await this.lifecycle.cancelByCustomer(user.id, id, dto, clientMeta(req));
    return this.query.detailForCustomer(user.id, id);
  }

  // ---- quotes

  @Get(':bookingId/quotes')
  @ApiOperation({
    summary: 'Compare quotes',
    description: 'Live quotes by default (cheapest first). Each shows price, VAT, total, proposed time, message and the worker\'s profile summary.',
  })
  @ApiOkResponse({ type: PagedQuotesDto })
  quotes(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) id: string, @Query() q: ListQuotesQueryDto) {
    return this.query.quotesForCustomer(user.id, id, q);
  }

  @Post(':bookingId/quotes/:quoteId/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept one quote',
    description: 'The booking moves to PAYMENT_PENDING and the other quotes are rejected. Only one quote can ever be accepted. Send expectedVersion to be sure you accept the offer you saw.',
  })
  @ApiOkResponse({ type: BookingDetailDto })
  async accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('bookingId', uuid()) id: string,
    @Param('quoteId', uuid()) quoteId: string,
    @Body() dto: AcceptQuoteDto,
  ) {
    await this.lifecycle.acceptQuote(user.id, id, quoteId, dto.expectedVersion);
    return this.query.detailForCustomer(user.id, id);
  }

  @Post(':bookingId/quotes/:quoteId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject one quote', description: 'The booking stays open: the other quotes can still be chosen. The worker is told their quote was not chosen.' })
  @ApiOkResponse({ type: BookingDetailDto })
  async rejectQuote(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) id: string, @Param('quoteId', uuid()) quoteId: string) {
    await this.lifecycle.rejectQuote(user.id, id, quoteId);
    return this.query.detailForCustomer(user.id, id);
  }

  @Post(':bookingId/quotes/:quoteId/request-change')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ask the worker to change a quote', description: 'The worker is notified and sees the message on the quote until they edit it.' })
  @ApiOkResponse({ type: BookingDetailDto })
  async requestQuoteChange(
    @CurrentUser() user: AuthenticatedUser,
    @Param('bookingId', uuid()) id: string,
    @Param('quoteId', uuid()) quoteId: string,
    @Body() dto: RequestQuoteChangeDto,
  ) {
    await this.lifecycle.requestQuoteChange(user.id, id, quoteId, dto.message);
    return this.query.detailForCustomer(user.id, id);
  }

  // ---- photos

  @Post(':bookingId/photos')
  @RateLimit({ name: 'file-register', limit: 120, windowSeconds: 600 })
  @ApiOperation({ summary: 'Register a problem photo and get a signed upload URL (503 while no storage is configured)' })
  @ApiCreatedResponse({ type: PhotoUploadDto })
  registerPhoto(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) id: string, @Body() dto: RegisterBookingPhotoDto) {
    return this.photos.register(user.id, id, dto);
  }

  @Post(':bookingId/photos/:photoId/confirm')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'file-confirm', limit: 240, windowSeconds: 600 })
  @ApiOkResponse({ type: BookingPhotoDto })
  confirmPhoto(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) id: string, @Param('photoId', uuid()) photoId: string) {
    return this.photos.confirm(user.id, id, photoId);
  }

  @Delete(':bookingId/photos/:photoId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async removePhoto(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) id: string, @Param('photoId', uuid()) photoId: string) {
    await this.photos.remove(user.id, id, photoId);
  }

  @Get(':bookingId/photos/:photoId/download-url')
  @ApiOkResponse({ type: PhotoDownloadDto })
  photoLink(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) id: string, @Param('photoId', uuid()) photoId: string) {
    return this.photos.forCustomer(user.id, id, photoId);
  }
}

// ===========================================================================
// Worker app (approved workers only)
// ===========================================================================

@ApiTags('Worker requests and jobs')
@ApiBearerAuth()
@RequireApprovedWorker()
@Controller({ path: 'workers/me', version: '1' })
export class WorkerBookingsController {
  constructor(
    private readonly lifecycle: BookingLifecycleService,
    private readonly quotes: QuotesService,
    private readonly query: BookingsQueryService,
    private readonly photos: BookingPhotosService,
  ) {}

  @Get('requests')
  @ApiOperation({
    summary: 'Open requests I can quote on',
    description: 'Only requests for services I offer in cities I serve. Location is limited to city and district.',
  })
  @ApiOkResponse({ type: PagedWorkerRequestsDto })
  requests(@CurrentUser() user: AuthenticatedUser, @Query() q: ListRequestsQueryDto) {
    return this.query.requests(user.id, q);
  }

  @Get('requests/:bookingId')
  @ApiOkResponse({ type: WorkerRequestDetailDto })
  request(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) id: string) {
    return this.query.requestDetail(user.id, id);
  }

  @Get('requests/:bookingId/photos/:photoId/download-url')
  @ApiOkResponse({ type: PhotoDownloadDto })
  requestPhoto(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) id: string, @Param('photoId', uuid()) photoId: string) {
    return this.photos.forWorker(user.id, id, photoId);
  }

  @Post('requests/:bookingId/quote')
  @ApiOperation({
    summary: 'Send a quote',
    description: 'Send only YOUR price before VAT in halalas. VAT, commission and the total are computed by the server and returned.',
  })
  @ApiCreatedResponse({ type: QuoteForWorkerDto })
  async submitQuote(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) id: string, @Body() dto: CreateQuoteDto) {
    const { id: quoteId } = await this.quotes.submit(user.id, id, dto);
    return this.query.myQuote(user.id, quoteId);
  }

  @Get('quotes')
  @ApiOperation({ summary: 'My quotes' })
  @ApiOkResponse({ type: PagedWorkerQuotesDto })
  myQuotes(@CurrentUser() user: AuthenticatedUser, @Query() q: ListMyQuotesQueryDto) {
    return this.query.myQuotes(user.id, q);
  }

  @Patch('quotes/:quoteId')
  @ApiOperation({ summary: 'Edit my live quote (re-priced at the pricing in force now)' })
  @ApiOkResponse({ type: QuoteForWorkerDto })
  async editQuote(@CurrentUser() user: AuthenticatedUser, @Param('quoteId', uuid()) quoteId: string, @Body() dto: UpdateQuoteDto) {
    await this.quotes.revise(user.id, quoteId, dto);
    return this.query.myQuote(user.id, quoteId);
  }

  @Post('quotes/:quoteId/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw my quote (not possible once it was accepted)' })
  @ApiOkResponse({ type: QuoteForWorkerDto })
  async withdrawQuote(@CurrentUser() user: AuthenticatedUser, @Param('quoteId', uuid()) quoteId: string) {
    await this.quotes.withdraw(user.id, quoteId);
    return this.query.myQuote(user.id, quoteId);
  }

  @Get('bookings')
  @ApiOperation({ summary: 'Bookings assigned to me' })
  @ApiOkResponse({ type: PagedWorkerBookingsDto })
  bookings(@CurrentUser() user: AuthenticatedUser, @Query() q: ListBookingsQueryDto) {
    return this.query.myBookings(user.id, q);
  }

  @Get('bookings/:bookingId')
  @ApiOperation({ summary: 'One assigned booking. Full address and customer contact appear once it is paid.' })
  @ApiOkResponse({ type: WorkerBookingDto })
  booking(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) id: string) {
    return this.query.myBookingDetail(user.id, id);
  }

  @Post('bookings/:bookingId/arrived')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Say you have reached the customer (paid booking, before starting the work)' })
  @ApiOkResponse({ type: WorkerBookingDto })
  async arrived(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) id: string) {
    const worker = await this.quotes.workerContext(user.id);
    await this.lifecycle.markArrived(worker.id, id);
    return this.query.myBookingDetail(user.id, id);
  }

  @Post('bookings/:bookingId/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start the job (CONFIRMED -> IN_PROGRESS)' })
  @ApiOkResponse({ type: WorkerBookingDto })
  async start(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) id: string) {
    const worker = await this.quotes.workerContext(user.id);
    await this.lifecycle.startWork(worker.id, user.id, id);
    return this.query.myBookingDetail(user.id, id);
  }

  @Post('bookings/:bookingId/cash-collected')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm that you received the cash for this booking (CASH bookings, once the work has started)' })
  @ApiOkResponse({ type: WorkerBookingDto })
  async cashCollected(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) id: string) {
    const worker = await this.quotes.workerContext(user.id);
    await this.lifecycle.markCashCollected(worker.id, id);
    return this.query.myBookingDetail(user.id, id);
  }

  @Post('bookings/:bookingId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Finish the job (IN_PROGRESS -> COMPLETED)' })
  @ApiOkResponse({ type: WorkerBookingDto })
  async complete(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) id: string) {
    const worker = await this.quotes.workerContext(user.id);
    await this.lifecycle.completeWork(worker.id, user.id, id);
    return this.query.myBookingDetail(user.id, id);
  }
}

// ===========================================================================
// Administrators
// ===========================================================================

@ApiTags('Admin bookings')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/bookings', version: '1' })
export class AdminBookingsController {
  constructor(
    private readonly lifecycle: BookingLifecycleService,
    private readonly query: BookingsQueryService,
    private readonly photos: BookingPhotosService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'All bookings (filters: status, serviceId, cityId, customerId, workerId, reference, created range)' })
  @ApiOkResponse({ type: PagedBookingsDto })
  list(@Query() q: AdminListBookingsQueryDto) {
    return this.query.adminList(q);
  }

  @Get(':bookingId')
  @ApiOperation({ summary: 'Full booking with every quote, the money breakdown including commission, and the timeline' })
  @ApiOkResponse({ type: AdminBookingDetailDto })
  detail(@Param('bookingId', uuid()) id: string) {
    return this.query.adminDetail(id);
  }

  @Post(':bookingId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel any booking that is not finished; a note is required and recorded' })
  @ApiOkResponse({ type: AdminBookingDetailDto })
  async cancel(@CurrentUser() admin: AuthenticatedUser, @Param('bookingId', uuid()) id: string, @Body() dto: AdminCancelBookingDto, @Req() req: Request) {
    await this.lifecycle.cancelByAdmin(admin.id, id, dto, clientMeta(req));
    return this.query.adminDetail(id);
  }

  @Get(':bookingId/photos/:photoId/download-url')
  @ApiOperation({ summary: 'Signed link to a booking photo (audited)' })
  @ApiOkResponse({ type: PhotoDownloadDto })
  photoLink(@CurrentUser() admin: AuthenticatedUser, @Param('bookingId', uuid()) id: string, @Param('photoId', uuid()) photoId: string) {
    return this.photos.forAdmin(admin.id, id, photoId);
  }
}
