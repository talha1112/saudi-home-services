import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, IsUrl, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PageMetaDto, PageQueryDto, toOptionalBoolean } from '../../../common/pagination/pagination.js';
import { LedgerEntryType, PaymentStatus, RefundStatus, WebhookEventStatus } from '../../../generated/prisma/client.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const csvUpper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.split(',').map((v) => v.trim().toUpperCase()).filter(Boolean) : value;

// ======================================================================= requests

export class InitiatePaymentDto {
  @ApiPropertyOptional({
    description:
      'Where the hosted checkout sends the customer afterwards. Must belong to one of the configured origins (PAYMENT_RETURN_URL_ORIGINS). Returning to this address is NEVER proof of payment.',
  })
  @IsOptional()
  @Transform(trim)
  @IsUrl({ require_tld: false, protocols: ['https', 'http'], require_protocol: true })
  @MaxLength(512)
  returnUrl?: string;
}

export class ListMyPaymentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() bookingId?: string;

  @ApiPropertyOptional({ description: 'Comma-separated payment statuses' })
  @IsOptional()
  @Transform(csvUpper)
  @IsEnum(PaymentStatus, { each: true })
  status?: PaymentStatus[];
}

export class AdminListPaymentsQueryDto extends ListMyPaymentsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional({ description: 'Provider name, e.g. mock' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(40) provider?: string;

  @ApiPropertyOptional({ description: 'Only attempts created by the development mock (true) or only real ones (false)' })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  simulated?: boolean;

  @ApiPropertyOptional({ description: 'Only captured payments that were not applied to their booking' })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  needsReconciliation?: boolean;

  @ApiPropertyOptional({ description: 'Created on or after' }) @IsOptional() @Type(() => Date) createdFrom?: Date;
  @ApiPropertyOptional({ description: 'Created before' }) @IsOptional() @Type(() => Date) createdTo?: Date;
}

export class AdminListWebhookEventsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Comma-separated statuses' })
  @IsOptional()
  @Transform(csvUpper)
  @IsEnum(WebhookEventStatus, { each: true })
  status?: WebhookEventStatus[];

  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(40) provider?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() paymentId?: string;
  @ApiPropertyOptional({ description: 'Provider event id (exact)' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(128) providerEventId?: string;
}

export class RequestRefundDto {
  @ApiProperty({ example: 5000, description: 'Integer halalas. Must not exceed the captured amount still available.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  amountHalalas: number;

  @ApiProperty({ description: 'Why the refund is requested. Required, kept with the request and the audit log.' })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export class CancelRefundDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class AdminListRefundsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Comma-separated statuses' })
  @IsOptional()
  @Transform(csvUpper)
  @IsEnum(RefundStatus, { each: true })
  status?: RefundStatus[];

  @ApiPropertyOptional() @IsOptional() @IsUUID() paymentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() bookingId?: string;
}

export class AdminListLedgerQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() bookingId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() paymentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() refundId?: string;
  @ApiPropertyOptional({ enum: LedgerEntryType }) @IsOptional() @IsEnum(LedgerEntryType) entryType?: LedgerEntryType;
}

export class SimulatePaymentDto {
  @ApiProperty({ enum: ['succeeded', 'failed', 'cancelled', 'expired'] })
  @IsIn(['succeeded', 'failed', 'cancelled', 'expired'])
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'expired';

  @ApiPropertyOptional({ description: 'Override the captured amount (to rehearse mismatches). Default: the agreed total.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  amountHalalas?: number;

  @ApiPropertyOptional({ description: 'Override the currency (to rehearse mismatches).' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  currency?: string;

  @ApiPropertyOptional({ description: 'Reuse an event id to rehearse duplicate deliveries.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(4)
  @MaxLength(100)
  eventId?: string;
}

// ===================================================================== responses

export class CheckoutInfoDto {
  @ApiProperty({ nullable: true, description: 'Hosted payment page, only while the attempt is open' }) url: string | null;
  @ApiProperty({ nullable: true }) expiresAt: string | null;
}

export class FailureInfoDto {
  @ApiProperty() code: string;
  @ApiProperty({ nullable: true }) message: string | null;
}

/** What the paying customer sees. No provider references, no internal flags except `simulated`. */
export class PaymentAttemptDto {
  @ApiProperty() id: string;
  @ApiProperty() bookingId: string;
  @ApiProperty() attemptNumber: number;
  @ApiProperty({ enum: PaymentStatus }) status: PaymentStatus;
  @ApiProperty({ description: 'Integer halalas, copied from the agreed booking total' }) amountHalalas: number;
  @ApiProperty({ example: 'SAR' }) currency: string;
  @ApiProperty({ description: 'True when created by the development mock provider: no real money' }) simulated: boolean;
  @ApiProperty({ type: CheckoutInfoDto, nullable: true }) checkout: CheckoutInfoDto | null;
  @ApiProperty({ type: FailureInfoDto, nullable: true }) failure: FailureInfoDto | null;
  @ApiProperty() createdAt: string;
}

export class PagedPaymentsDto {
  @ApiProperty({ type: [PaymentAttemptDto] }) items: PaymentAttemptDto[];
  @ApiProperty({ type: PageMetaDto }) meta: PageMetaDto;
}

export class WebhookReceivedDto {
  @ApiProperty({ example: true }) received: boolean;
  @ApiProperty({ enum: ['processed', 'ignored', 'duplicate', 'in_progress'] }) result: string;
}
