import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  type RawBodyRequest,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ApiError, badRequest } from '../../common/errors/api-error.js';
import { APP_CONFIG, type AppConfig } from '../../config/app.config.js';
import { Role } from '../../generated/prisma/client.js';
import { AuditService } from '../auth/audit.service.js';
import { clientMeta } from '../auth/auth.controller.js';
import {
  AdminPaymentDetailDto,
  PagedAdminPaymentsDto,
  PagedLedgerDto,
  PagedRefundsDto,
  PagedWebhookEventsDto,
  ReconciliationReportDto,
  RefundCreatedDto,
  RefundDto,
  WebhookEventDto,
} from './dto/admin-payments.dto.js';
import {
  AdminListLedgerQueryDto,
  AdminListPaymentsQueryDto,
  AdminListRefundsQueryDto,
  AdminListWebhookEventsQueryDto,
  CancelRefundDto,
  InitiatePaymentDto,
  ListMyPaymentsQueryDto,
  PagedPaymentsDto,
  PaymentAttemptDto,
  RequestRefundDto,
  SimulatePaymentDto,
  WebhookReceivedDto,
} from './dto/payments.dto.js';
import { BookingLifecycleService } from '../bookings/booking-lifecycle.service.js';
import { BookingsQueryService } from '../bookings/bookings-query.service.js';
import { BookingDetailDto } from '../bookings/dto/bookings.dto.js';
import { PaymentEventsService } from './payment-events.service.js';
import { PaymentSimulationService, SimulationEnabledGuard } from './payment-simulation.service.js';
import { PaymentsAdminService, toRefundDto } from './payments-admin.service.js';
import { parseIdempotencyKey, sha256 } from './payments-support.js';
import { PaymentsService } from './payments.service.js';
import { InvalidWebhookSignatureError, PaymentProvider } from './provider/payment-provider.js';
import { RefundsService } from './refunds.service.js';

const IDEMPOTENCY_HEADER = {
  name: 'Idempotency-Key',
  required: true,
  description: 'Unique per intended operation (8-128 characters). Repeating a request with the same key and body returns the same result; the same key with a different body is refused (409).',
} as const;

const uuid = () => new ParseUUIDPipe();

// ===========================================================================
// Customer
// ===========================================================================

@ApiTags('Payments')
@ApiBearerAuth()
@Roles(Role.CUSTOMER)
@Controller({ path: 'bookings/:bookingId/payments', version: '1' })
export class BookingPaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly lifecycle: BookingLifecycleService,
    private readonly bookings: BookingsQueryService,
  ) {}

  @Post('cash')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'payment-initiate', limit: 20, windowSeconds: 600 })
  @ApiOperation({
    summary: 'Pay this booking in cash',
    description:
      'Only for a booking in PAYMENT_PENDING that you own. The booking is confirmed at once and you pay the agreed total to the worker in person; ' +
      'no money moves through the platform. Repeating the call on a booking already confirmed as cash changes nothing. ' +
      'Refused while an online payment for the booking is in progress.',
  })
  @ApiOkResponse({ type: BookingDetailDto })
  async payCash(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', uuid()) bookingId: string) {
    await this.lifecycle.chooseCash(user.id, bookingId);
    return this.bookings.detailForCustomer(user.id, bookingId);
  }

  @Post()
  @RateLimit({ name: 'payment-initiate', limit: 20, windowSeconds: 600 })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: 'Start paying for my booking',
    description:
      'Only for a booking in PAYMENT_PENDING that you own. The amount is the agreed total and cannot be sent by the client. ' +
      'Returns 503 PAYMENT_PROVIDER_NOT_CONFIGURED while no payment provider is configured (the default). ' +
      'With the development mock provider the checkout is SIMULATED (`simulated: true`) and no money moves. ' +
      'Coming back from the checkout page is NOT proof of payment: the booking becomes CONFIRMED only after the server receives a verified provider event.',
  })
  @ApiCreatedResponse({ type: PaymentAttemptDto })
  initiate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('bookingId', uuid()) bookingId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: InitiatePaymentDto,
  ) {
    return this.payments.initiate(user.id, bookingId, parseIdempotencyKey(key), dto);
  }
}

@ApiTags('Payments')
@ApiBearerAuth()
@Roles(Role.CUSTOMER)
@Controller({ path: 'payments', version: '1' })
export class MyPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @ApiOperation({ summary: 'My payment attempts' })
  @ApiOkResponse({ type: PagedPaymentsDto })
  list(@CurrentUser() user: AuthenticatedUser, @Query() q: ListMyPaymentsQueryDto) {
    return this.payments.listMine(user.id, q);
  }

  @Get(':paymentId')
  @ApiOkResponse({ type: PaymentAttemptDto })
  get(@CurrentUser() user: AuthenticatedUser, @Param('paymentId', uuid()) id: string) {
    return this.payments.getMine(user.id, id);
  }

  @Post(':paymentId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Abandon an unfinished payment attempt so a new one can be started' })
  @ApiOkResponse({ type: PaymentAttemptDto })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('paymentId', uuid()) id: string) {
    return this.payments.cancelMine(user.id, id);
  }
}

// ===========================================================================
// Provider webhooks (public route; trust comes only from the signature)
// ===========================================================================

@ApiTags('Payment webhooks')
@Public()
@RateLimit({ name: 'payment-webhook', limit: 600, windowSeconds: 60 })
@Controller({ path: 'payments/webhooks', version: '1' })
export class PaymentWebhookController {
  private readonly maxBytes: number;

  constructor(
    config: ConfigService,
    private readonly provider: PaymentProvider,
    private readonly events: PaymentEventsService,
  ) {
    this.maxBytes = config.getOrThrow<AppConfig>(APP_CONFIG).payments.webhookMaxBodyBytes;
  }

  @Post(':provider')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receive a payment provider event',
    description:
      'Accepted only for a configured provider whose adapter verifies the signature over the exact raw body. ' +
      'No real provider exists yet: with the disabled or mock provider this route answers 404. ' +
      'An invalid signature changes nothing. Duplicates and out-of-order events are safe.',
  })
  @ApiOkResponse({ type: WebhookReceivedDto })
  async receive(@Param('provider') name: string, @Req() req: RawBodyRequest<Request>): Promise<WebhookReceivedDto> {
    if (name !== this.provider.name || !this.provider.acceptsPublicWebhooks) {
      throw new ApiError(HttpStatus.NOT_FOUND, 'PAYMENT_PROVIDER_NOT_FOUND', 'Unknown payment provider');
    }
    const raw = req.rawBody;
    if (!raw || raw.length === 0) throw badRequest('EMPTY_BODY', 'The request has no body');
    if (raw.length > this.maxBytes) throw new ApiError(HttpStatus.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE', 'The request body is too large');

    let event;
    try {
      // Authenticity is decided here, over the exact bytes received, BEFORE anything is stored or changed.
      event = this.provider.verifyWebhook(raw, req.headers);
    } catch (err) {
      if (err instanceof InvalidWebhookSignatureError) {
        throw new ApiError(HttpStatus.UNAUTHORIZED, 'INVALID_SIGNATURE', 'The signature could not be verified');
      }
      throw err;
    }
    const result = await this.events.handleVerified(this.provider.name, event, sha256(raw.toString('utf8')));
    return { received: true, result };
  }
}

// ===========================================================================
// Administrators
// ===========================================================================

@ApiTags('Admin payments')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/payments', version: '1' })
export class AdminPaymentsController {
  constructor(
    private readonly admin: PaymentsAdminService,
    private readonly events: PaymentEventsService,
    private readonly refunds: RefundsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Payment attempts (filters: status, bookingId, customerId, provider, simulated, needsReconciliation, created range)' })
  @ApiOkResponse({ type: PagedAdminPaymentsDto })
  list(@Query() q: AdminListPaymentsQueryDto) {
    return this.admin.listPayments(q);
  }

  @Get('reconciliation')
  @ApiOperation({
    summary: 'Items that need a human: overdue unpaid bookings, stale attempts, captured-but-unapplied payments, failed and orphan events',
    description: 'Report only. It does not reconcile external gateway balances and changes nothing.',
  })
  @ApiOkResponse({ type: ReconciliationReportDto })
  reconciliation() {
    return this.admin.report();
  }

  @Get('webhook-events')
  @ApiOperation({ summary: 'Verified provider events and how they were processed' })
  @ApiOkResponse({ type: PagedWebhookEventsDto })
  webhookEvents(@Query() q: AdminListWebhookEventsQueryDto) {
    return this.admin.listWebhookEvents(q);
  }

  @Get('webhook-events/:eventId')
  @ApiOkResponse({ type: WebhookEventDto })
  webhookEvent(@Param('eventId', uuid()) id: string) {
    return this.admin.getWebhookEvent(id);
  }

  @Post('webhook-events/:eventId/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Process a FAILED event again (or an unknown-payment event whose payment now exists)' })
  @ApiOkResponse({ type: WebhookEventDto })
  async retry(@CurrentUser() admin: AuthenticatedUser, @Param('eventId', uuid()) id: string, @Req() req: Request) {
    await this.events.retry(id);
    // Re-processing a stored, signature-verified event is the only thing an admin can trigger here; it can never mark a payment paid by hand.
    const meta = clientMeta(req);
    await this.audit.record({ action: 'payment.webhook_event.retried', actorUserId: admin.id, entityType: 'payment_webhook_event', entityId: id, ipAddress: meta.ip, userAgent: meta.userAgent });
    return this.admin.getWebhookEvent(id);
  }

  @Get(':paymentId')
  @ApiOperation({ summary: 'One payment with its booking history, provider events, refunds and ledger entries' })
  @ApiOkResponse({ type: AdminPaymentDetailDto })
  detail(@Param('paymentId', uuid()) id: string) {
    return this.admin.paymentDetail(id);
  }

  @Post(':paymentId/refunds')
  @RateLimit({ name: 'refund-request', limit: 60, windowSeconds: 600 })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: 'Request a refund',
    description: 'Creates a REQUEST only. No money is returned and no ledger entry is posted until a provider confirms it (a later phase). The amount can never exceed the captured amount still available.',
  })
  @ApiCreatedResponse({ type: RefundCreatedDto })
  async requestRefund(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('paymentId', uuid()) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: RequestRefundDto,
    @Req() req: Request,
  ): Promise<RefundCreatedDto> {
    const refund = await this.refunds.request(admin.id, id, parseIdempotencyKey(key), dto, clientMeta(req));
    return { ...toRefundDto(refund), notice: 'Refund REQUESTED. No money has been returned until a provider confirms it.' };
  }
}

@ApiTags('Admin payments')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/refunds', version: '1' })
export class AdminRefundsController {
  constructor(
    private readonly admin: PaymentsAdminService,
    private readonly refunds: RefundsService,
  ) {}

  @Get()
  @ApiOkResponse({ type: PagedRefundsDto })
  list(@Query() q: AdminListRefundsQueryDto) {
    return this.admin.listRefunds(q);
  }

  @Get(':refundId')
  @ApiOkResponse({ type: RefundDto })
  get(@Param('refundId', uuid()) id: string) {
    return this.admin.getRefund(id);
  }

  @Post(':refundId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw a refund request that has not reached a provider, releasing the reserved amount' })
  @ApiOkResponse({ type: RefundDto })
  async cancel(@CurrentUser() admin: AuthenticatedUser, @Param('refundId', uuid()) id: string, @Body() dto: CancelRefundDto, @Req() req: Request) {
    return toRefundDto(await this.refunds.cancel(admin.id, id, dto.reason, clientMeta(req)));
  }
}

@ApiTags('Admin payments')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/ledger', version: '1' })
export class AdminLedgerController {
  constructor(private readonly admin: PaymentsAdminService) {}

  @Get()
  @ApiOperation({
    summary: 'Ledger entries (read-only)',
    description: 'The ledger is append-only. There is no endpoint to create, edit or delete entries.',
  })
  @ApiOkResponse({ type: PagedLedgerDto })
  list(@Query() q: AdminListLedgerQueryDto) {
    return this.admin.listLedger(q);
  }
}

// ===========================================================================
// Development only
// ===========================================================================

@ApiTags('Payments (development only)')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@UseGuards(SimulationEnabledGuard)
@Controller({ path: 'dev/payments', version: '1' })
export class DevPaymentSimulationController {
  constructor(
    private readonly simulation: PaymentSimulationService,
    private readonly admin: PaymentsAdminService,
  ) {}

  @Post(':paymentId/simulate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'DEVELOPMENT ONLY: rehearse the outcome of a MOCK payment',
    description:
      'Exists only while PAYMENT_PROVIDER=mock outside production (404 otherwise). Administrators only. ' +
      'Not a webhook: it only affects simulated attempts and everything it creates is flagged simulated.',
  })
  @ApiOkResponse({ type: AdminPaymentDetailDto })
  async simulate(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('paymentId', uuid()) id: string,
    @Body() dto: SimulatePaymentDto,
    @Req() req: Request,
  ) {
    await this.simulation.simulate(admin.id, id, dto, clientMeta(req));
    return this.admin.paymentDetail(id);
  }
}
