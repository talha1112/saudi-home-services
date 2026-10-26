import { ApiProperty } from '@nestjs/swagger';
import { PageMetaDto } from '../../../common/pagination/pagination.js';
import { BookingEventType, BookingStatus, LedgerEntryType, PaymentStatus, RefundStatus, WebhookEventStatus } from '../../../generated/prisma/client.js';

export class AdminPaymentDto {
  @ApiProperty() id: string;
  @ApiProperty() bookingId: string;
  @ApiProperty() bookingReference: string;
  @ApiProperty() customerId: string;
  @ApiProperty() attemptNumber: number;
  @ApiProperty() provider: string;
  @ApiProperty({ nullable: true }) providerPaymentId: string | null;
  @ApiProperty({ enum: PaymentStatus }) status: PaymentStatus;
  @ApiProperty({ description: 'Agreed amount, integer halalas' }) amountHalalas: number;
  @ApiProperty() currency: string;
  @ApiProperty({ description: 'Created by the development mock: no real money' }) simulated: boolean;
  @ApiProperty({ nullable: true, description: 'What the provider reported capturing' }) capturedAmountHalalas: number | null;
  @ApiProperty({ nullable: true }) capturedCurrency: string | null;
  @ApiProperty({ description: 'Requested + in-progress + completed refunds' }) refundReservedHalalas: number;
  @ApiProperty({ nullable: true }) failureCode: string | null;
  @ApiProperty({ nullable: true }) failureMessage: string | null;
  @ApiProperty({ nullable: true, description: 'Why captured money was not applied to the booking' }) reconciliationReason: string | null;
  @ApiProperty({ description: 'Captured but not applied to its booking' }) needsReconciliation: boolean;
  @ApiProperty() createdAt: string;
  @ApiProperty({ nullable: true }) processingAt: string | null;
  @ApiProperty({ nullable: true }) settledAt: string | null;
}

export class PagedAdminPaymentsDto {
  @ApiProperty({ type: [AdminPaymentDto] }) items: AdminPaymentDto[];
  @ApiProperty({ type: PageMetaDto }) meta: PageMetaDto;
}

export class WebhookEventDto {
  @ApiProperty() id: string;
  @ApiProperty() provider: string;
  @ApiProperty() accountScope: string;
  @ApiProperty() providerEventId: string;
  @ApiProperty() eventType: string;
  @ApiProperty({ nullable: true }) providerPaymentId: string | null;
  @ApiProperty({ nullable: true }) paymentId: string | null;
  @ApiProperty({ enum: WebhookEventStatus }) status: WebhookEventStatus;
  @ApiProperty({ nullable: true, description: 'What processing decided' }) outcome: string | null;
  @ApiProperty() attempts: number;
  @ApiProperty({ nullable: true }) amountHalalas: number | null;
  @ApiProperty({ nullable: true }) currency: string | null;
  @ApiProperty({ nullable: true }) occurredAt: string | null;
  @ApiProperty() simulated: boolean;
  @ApiProperty({ nullable: true, description: 'Short machine summary; never provider text or secrets' }) lastError: string | null;
  @ApiProperty() receivedAt: string;
  @ApiProperty({ nullable: true }) processedAt: string | null;
}

export class PagedWebhookEventsDto {
  @ApiProperty({ type: [WebhookEventDto] }) items: WebhookEventDto[];
  @ApiProperty({ type: PageMetaDto }) meta: PageMetaDto;
}

export class RefundDto {
  @ApiProperty() id: string;
  @ApiProperty() paymentId: string;
  @ApiProperty() bookingId: string;
  @ApiProperty() amountHalalas: number;
  @ApiProperty() currency: string;
  @ApiProperty() reason: string;
  @ApiProperty({ enum: RefundStatus }) status: RefundStatus;
  @ApiProperty({ description: 'TRUE only once a provider confirmed it. REQUESTED means NO money has been returned.' }) moneyReturned: boolean;
  @ApiProperty() requestedById: string;
  @ApiProperty({ nullable: true }) providerRefundId: string | null;
  @ApiProperty({ nullable: true }) failureCode: string | null;
  @ApiProperty() createdAt: string;
  @ApiProperty({ nullable: true }) completedAt: string | null;
}

export class PagedRefundsDto {
  @ApiProperty({ type: [RefundDto] }) items: RefundDto[];
  @ApiProperty({ type: PageMetaDto }) meta: PageMetaDto;
}

export class LedgerEntryDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: LedgerEntryType }) entryType: LedgerEntryType;
  @ApiProperty({ description: 'Signed integer halalas: + received, - paid out' }) amountHalalas: number;
  @ApiProperty() currency: string;
  @ApiProperty({ nullable: true }) bookingId: string | null;
  @ApiProperty({ nullable: true }) paymentId: string | null;
  @ApiProperty({ nullable: true }) refundId: string | null;
  @ApiProperty({ nullable: true }) reversesEntryId: string | null;
  @ApiProperty() idempotencyKey: string;
  @ApiProperty() sourceType: string;
  @ApiProperty({ nullable: true }) sourceId: string | null;
  @ApiProperty() description: string;
  @ApiProperty() simulated: boolean;
  @ApiProperty() postedAt: string;
}

export class PagedLedgerDto {
  @ApiProperty({ type: [LedgerEntryDto] }) items: LedgerEntryDto[];
  @ApiProperty({ type: PageMetaDto }) meta: PageMetaDto;
}

export class PaymentBookingSummaryDto {
  @ApiProperty() id: string;
  @ApiProperty() reference: string;
  @ApiProperty({ enum: BookingStatus }) status: BookingStatus;
  @ApiProperty({ nullable: true }) totalAmountHalalas: number | null;
  @ApiProperty() currency: string;
  @ApiProperty({ nullable: true }) paymentDueAt: string | null;
  @ApiProperty({ nullable: true }) confirmedAt: string | null;
}

export class BookingTimelineItemDto {
  @ApiProperty({ enum: BookingEventType }) type: BookingEventType;
  @ApiProperty({ enum: BookingStatus, nullable: true }) fromStatus: BookingStatus | null;
  @ApiProperty({ enum: BookingStatus, nullable: true }) toStatus: BookingStatus | null;
  @ApiProperty({ nullable: true }) note: string | null;
  @ApiProperty() createdAt: string;
}

export class AdminPaymentDetailDto extends AdminPaymentDto {
  @ApiProperty({ type: PaymentBookingSummaryDto }) booking: PaymentBookingSummaryDto;
  @ApiProperty({ type: [BookingTimelineItemDto] }) bookingTimeline: BookingTimelineItemDto[];
  @ApiProperty({ type: [WebhookEventDto] }) webhookEvents: WebhookEventDto[];
  @ApiProperty({ type: [RefundDto] }) refunds: RefundDto[];
  @ApiProperty({ type: [LedgerEntryDto] }) ledger: LedgerEntryDto[];
}

export class RefundCreatedDto extends RefundDto {
  @ApiProperty({ example: 'Refund REQUESTED. No money has been returned until a provider confirms it.' }) notice: string;
}

export class ReconciliationReportDto {
  @ApiProperty() generatedAt: string;
  @ApiProperty({ example: 'REPORT_ONLY', description: 'Overdue unpaid bookings are only reported: what to do with them is an undecided business rule' }) deadlineAction: string;
  @ApiProperty({ type: [PaymentBookingSummaryDto] }) overduePendingBookings: PaymentBookingSummaryDto[];
  @ApiProperty({ type: [AdminPaymentDto], description: 'PROCESSING/INITIATED for longer than PAYMENT_STALE_AFTER_MINUTES. Reported only; never marked successful automatically.' }) staleAttempts: AdminPaymentDto[];
  @ApiProperty({ type: [AdminPaymentDto], description: 'Money captured but not applied to the booking' }) capturedUnapplied: AdminPaymentDto[];
  @ApiProperty({ type: [WebhookEventDto] }) failedWebhookEvents: WebhookEventDto[];
  @ApiProperty({ type: [WebhookEventDto], description: 'Events naming a payment we do not know' }) orphanWebhookEvents: WebhookEventDto[];
}
