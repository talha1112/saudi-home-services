import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PageMetaDto, PageQueryDto, toOptionalBoolean } from '../../../common/pagination/pagination.js';
import {
  BookingEventType,
  BookingStatus,
  CancellationReason,
  PhotoStatus,
  QuoteStatus,
  Role,
  ScanStatus,
} from '../../../generated/prisma/client.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToUndefined = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? undefined : trim({ value }));
const csvUpper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.split(',').map((v) => v.trim().toUpperCase()).filter(Boolean) : value;

export const BOOKING_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png'] as const;
export const MAX_BOOKING_PHOTO_BYTES = 8 * 1024 * 1024;

/** Reasons a customer may pick. ADMIN_ACTION is reserved for administrators. */
export const CUSTOMER_CANCELLATION_REASONS = Object.values(CancellationReason).filter((r) => r !== CancellationReason.ADMIN_ACTION);

// ===================================================================== requests

export class CreateBookingDto {
  @ApiProperty() @IsUUID() serviceId: string;
  @ApiProperty({ description: 'A city from GET /catalog/cities' }) @IsUUID() cityId: string;

  @ApiProperty({ example: 'The kitchen outlet sparks when I plug anything in.', minLength: 10, maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  problemDescription: string;

  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() isUrgent?: boolean;

  @ApiProperty({ example: '2026-11-02T09:00:00+03:00', description: 'Earliest time that suits the customer' })
  @IsDateString({ strict: true })
  preferredStartAt: string;

  @ApiProperty({ example: '2026-11-02T13:00:00+03:00', description: 'Latest time that suits the customer' })
  @IsDateString({ strict: true })
  preferredEndAt: string;

  @ApiPropertyOptional() @IsOptional() @Transform(emptyToUndefined) @IsString() @MaxLength(120) district?: string;

  @ApiProperty({ description: 'Street address. Shown to the chosen worker only after payment.' })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  addressLine: string;

  @ApiPropertyOptional() @IsOptional() @Transform(emptyToUndefined) @IsString() @MaxLength(120) building?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToUndefined) @IsString() @MaxLength(500) locationNotes?: string;

  @ApiPropertyOptional({ example: 24.7136 })
  @ValidateIf((o: CreateBookingDto) => o.latitude !== undefined || o.longitude !== undefined)
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({ example: 46.6753 })
  @ValidateIf((o: CreateBookingDto) => o.latitude !== undefined || o.longitude !== undefined)
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;
}

export class CancelBookingDto {
  @ApiProperty({ enum: CUSTOMER_CANCELLATION_REASONS })
  @IsIn(CUSTOMER_CANCELLATION_REASONS)
  reason: CancellationReason;

  @ApiPropertyOptional({ description: 'Required when the reason is OTHER' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class AdminCancelBookingDto {
  @ApiProperty({ description: 'Why the administrator cancels. Kept in the booking history.' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  note: string;
}

export class AcceptQuoteDto {
  @ApiPropertyOptional({
    description:
      'The quote version the customer was looking at. If the worker changed the quote since, the request fails with 409 QUOTE_CHANGED instead of accepting a different price. Never used to set a price.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class RegisterBookingPhotoDto {
  @ApiProperty({ example: 'outlet.jpg' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName: string;

  @ApiProperty({ enum: BOOKING_PHOTO_MIME_TYPES })
  @IsIn(BOOKING_PHOTO_MIME_TYPES)
  mimeType: string;

  @ApiProperty({ maximum: MAX_BOOKING_PHOTO_BYTES })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_BOOKING_PHOTO_BYTES)
  sizeBytes: number;
}

export class ListBookingsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Comma-separated statuses, e.g. OPEN,PAYMENT_PENDING', example: 'OPEN' })
  @IsOptional()
  @Transform(csvUpper)
  @IsEnum(BookingStatus, { each: true })
  status?: BookingStatus[];

  @ApiPropertyOptional() @IsOptional() @IsUUID() serviceId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() cityId?: string;
  @ApiPropertyOptional({ description: 'Created on or after (ISO date/time)' }) @IsOptional() @IsDateString({ strict: true }) createdFrom?: string;
  @ApiPropertyOptional({ description: 'Created before (ISO date/time)' }) @IsOptional() @IsDateString({ strict: true }) createdTo?: string;

  @ApiPropertyOptional({ enum: ['newest', 'oldest', 'soonest'], default: 'newest', description: 'soonest = by preferred start time' })
  @IsOptional()
  @IsIn(['newest', 'oldest', 'soonest'])
  sort: 'newest' | 'oldest' | 'soonest' = 'newest';
}

export class AdminListBookingsQueryDto extends ListBookingsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional({ description: 'Worker profile id' }) @IsOptional() @IsUUID() workerId?: string;
  @ApiPropertyOptional({ description: 'Search: booking reference (prefix), customer or worker name, customer phone, service name' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(60)
  q?: string;

  @ApiPropertyOptional({ enum: ['CASH', 'ONLINE'], description: 'How the booking is paid' })
  @IsOptional()
  @IsIn(['CASH', 'ONLINE'])
  paymentMethod?: 'CASH' | 'ONLINE';

  @ApiPropertyOptional({ description: 'Booking reference, e.g. BK-7H3K9Q2M (prefix match)' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @MaxLength(16)
  reference?: string;
}

export class ListQuotesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Comma-separated statuses. Default: SUBMITTED (live, not expired).' })
  @IsOptional()
  @Transform(csvUpper)
  @IsEnum(QuoteStatus, { each: true })
  status?: QuoteStatus[];

  @ApiPropertyOptional({ enum: ['price_asc', 'price_desc', 'soonest', 'newest'], default: 'price_asc' })
  @IsOptional()
  @IsIn(['price_asc', 'price_desc', 'soonest', 'newest'])
  sort: 'price_asc' | 'price_desc' | 'soonest' | 'newest' = 'price_asc';
}

export class ListRequestsQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() serviceId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() cityId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  urgentOnly?: boolean;

  @ApiPropertyOptional({ description: 'Preferred start on or after' }) @IsOptional() @IsDateString({ strict: true }) startFrom?: string;
  @ApiPropertyOptional({ description: 'Preferred start before' }) @IsOptional() @IsDateString({ strict: true }) startTo?: string;

  @ApiPropertyOptional({ enum: ['newest', 'soonest'], default: 'newest' })
  @IsOptional()
  @IsIn(['newest', 'soonest'])
  sort: 'newest' | 'soonest' = 'newest';
}

export class ListMyQuotesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Comma-separated quote statuses' })
  @IsOptional()
  @Transform(csvUpper)
  @IsEnum(QuoteStatus, { each: true })
  status?: QuoteStatus[];
}

export class CreateQuoteDto {
  @ApiProperty({ example: 25000, description: 'Your service price BEFORE VAT, in halalas (100 = SAR 1). VAT, commission and totals are computed by the server.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  priceHalalas: number;

  @ApiProperty({ description: 'When you can start' }) @IsDateString({ strict: true }) proposedStartAt: string;
  @ApiProperty({ description: 'When you expect to be done or free again' }) @IsDateString({ strict: true }) proposedEndAt: string;

  @ApiPropertyOptional({ example: 90 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(1440)
  estimatedDurationMinutes?: number;

  @ApiPropertyOptional({ description: 'A short note to the customer' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(1000)
  message?: string;

  @ApiPropertyOptional({ description: 'How long the offer stays valid (hours). Server default and maximum apply.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  validForHours?: number;
}

export class UpdateQuoteDto {
  @ApiPropertyOptional({ description: 'New service price before VAT, in halalas; re-priced at the pricing in force now' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  priceHalalas?: number;

  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) proposedStartAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) proposedEndAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(1440)
  estimatedDurationMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(1000)
  message?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  validForHours?: number;
}

// ==================================================================== responses

export class BookingEventDto {
  @ApiProperty({ enum: BookingEventType }) type: BookingEventType;
  @ApiProperty({ enum: BookingStatus, nullable: true }) fromStatus: BookingStatus | null;
  @ApiProperty({ enum: BookingStatus, nullable: true }) toStatus: BookingStatus | null;
  @ApiProperty({ enum: Role, nullable: true, description: 'Null for system actions' }) actorRole: Role | null;
  @ApiProperty({ nullable: true, description: 'Service price (halalas) for quote events' }) amountHalalas: number | null;
  @ApiProperty({ nullable: true }) note: string | null;
  @ApiProperty() createdAt: string;
}

export class BookingPhotoDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: PhotoStatus }) status: PhotoStatus;
  @ApiProperty() fileName: string;
  @ApiProperty() mimeType: string;
  @ApiProperty() sizeBytes: number;
  @ApiProperty({ enum: ScanStatus, description: 'Malware scan result. NOT_SCANNED means no scanner has looked at the file; it does not mean the file is safe.' }) scanStatus: ScanStatus;
}

export class PhotoUploadDto {
  @ApiProperty({ type: BookingPhotoDto }) photo: BookingPhotoDto;
  @ApiProperty() uploadUrl: string;
  @ApiProperty({ example: 'PUT' }) method: 'PUT';
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } }) headers: Record<string, string>;
  @ApiProperty() expiresAt: string;
}

export class PhotoDownloadDto {
  @ApiProperty() url: string;
  @ApiProperty() expiresAt: string;
}

/** Customer-facing money breakdown. Never contains the platform commission. */
export class CustomerMoneyDto {
  @ApiProperty({ example: 'SAR' }) currency: string;
  @ApiProperty({ description: 'Service price before VAT, halalas' }) serviceHalalas: number;
  @ApiProperty({ description: 'VAT, halalas' }) vatHalalas: number;
  @ApiProperty({ description: 'What the customer pays, halalas' }) totalHalalas: number;
  @ApiProperty({ description: 'VAT rate that was applied, basis points' }) vatRateBps: number;
}

export class WorkerPublicSummaryDto {
  @ApiProperty() workerId: string;
  @ApiProperty({ nullable: true }) fullName: string | null;
  @ApiProperty({ nullable: true }) fullNameAr: string | null;
  @ApiProperty({ nullable: true }) bio: string | null;
  @ApiProperty({ nullable: true }) yearsOfExperience: number | null;
  @ApiProperty({ nullable: true, description: 'Years in the requested service' }) serviceYearsOfExperience: number | null;
  @ApiProperty({ nullable: true, description: 'Reviews arrive in a later phase; always null for now' }) ratingAverage: number | null;
  @ApiProperty({ description: 'Always 0 until reviews exist' }) ratingCount: number;
  @ApiProperty({ description: 'Bookings this worker has completed through the platform' }) completedJobs: number;
}

export class QuoteForCustomerDto {
  @ApiProperty() id: string;
  @ApiProperty() bookingId: string;
  @ApiProperty({ enum: QuoteStatus }) status: QuoteStatus;
  @ApiProperty({ description: 'Send back as expectedVersion when accepting' }) version: number;
  @ApiProperty({ type: CustomerMoneyDto }) money: CustomerMoneyDto;
  @ApiProperty() proposedStartAt: string;
  @ApiProperty() proposedEndAt: string;
  @ApiProperty({ nullable: true }) estimatedDurationMinutes: number | null;
  @ApiProperty({ nullable: true }) message: string | null;
  @ApiProperty() validUntil: string;
  @ApiProperty({ description: 'True when still SUBMITTED but past validUntil' }) isExpired: boolean;
  @ApiProperty({ type: WorkerPublicSummaryDto }) worker: WorkerPublicSummaryDto;
  @ApiProperty() createdAt: string;
}

export class PagedQuotesDto {
  @ApiProperty({ type: [QuoteForCustomerDto] }) items: QuoteForCustomerDto[];
  @ApiProperty({ type: PageMetaDto }) meta: PageMetaDto;
}

export class BookingLocationDto {
  @ApiProperty() cityId: string;
  @ApiProperty() cityNameEn: string;
  @ApiProperty() cityNameAr: string;
  @ApiProperty({ nullable: true }) district: string | null;
  @ApiPropertyOptional({ description: 'Hidden from workers until the booking is paid' }) addressLine?: string;
  @ApiPropertyOptional({ nullable: true }) building?: string | null;
  @ApiPropertyOptional({ nullable: true }) locationNotes?: string | null;
  @ApiPropertyOptional({ nullable: true }) latitude?: number | null;
  @ApiPropertyOptional({ nullable: true }) longitude?: number | null;
}

export class BookingServiceDto {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty() nameEn: string;
  @ApiProperty() nameAr: string;
}

export class BookingSummaryDto {
  @ApiProperty() id: string;
  @ApiProperty() reference: string;
  @ApiProperty({ enum: BookingStatus }) status: BookingStatus;
  @ApiProperty({ type: BookingServiceDto }) service: BookingServiceDto;
  @ApiProperty() cityId: string;
  @ApiProperty() isUrgent: boolean;
  @ApiProperty() preferredStartAt: string;
  @ApiProperty() preferredEndAt: string;
  @ApiProperty() expiresAt: string;
  @ApiProperty({ description: 'Live quotes waiting for the customer' }) quoteCount: number;
  @ApiProperty({ type: CustomerMoneyDto, nullable: true, description: 'Set once a quote was accepted' }) money: CustomerMoneyDto | null;
  @ApiProperty() createdAt: string;
}

export class PagedBookingsDto {
  @ApiProperty({ type: [BookingSummaryDto] }) items: BookingSummaryDto[];
  @ApiProperty({ type: PageMetaDto }) meta: PageMetaDto;
}

export class AssignedWorkerDto {
  @ApiProperty() workerId: string;
  @ApiProperty({ nullable: true }) fullName: string | null;
  @ApiProperty({ nullable: true }) fullNameAr: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Shared only once the booking is paid (CONFIRMED or later)' }) phone?: string | null;
}

export class BookingDetailDto extends BookingSummaryDto {
  @ApiProperty() problemDescription: string;
  @ApiProperty({ type: BookingLocationDto }) location: BookingLocationDto;
  @ApiProperty({ type: AssignedWorkerDto, nullable: true }) worker: AssignedWorkerDto | null;
  @ApiProperty({ nullable: true }) acceptedQuoteId: string | null;
  @ApiProperty({ nullable: true, description: 'Pay before this time (payments phase)' }) paymentDueAt: string | null;
  @ApiProperty({ enum: ['ONLINE', 'CASH'], nullable: true, description: 'How it is paid once chosen; CASH = the customer pays the worker in person' }) paymentMethod: 'ONLINE' | 'CASH' | null;
  @ApiProperty({ type: [BookingPhotoDto] }) photos: BookingPhotoDto[];
  @ApiProperty({ type: [BookingEventDto] }) timeline: BookingEventDto[];
  @ApiProperty({ nullable: true }) cancelledAt: string | null;
  @ApiProperty({ enum: CancellationReason, nullable: true }) cancellationReason: CancellationReason | null;
}

// ---- worker side

export class WorkerMoneyDto extends CustomerMoneyDto {
  @ApiProperty({ description: 'Platform commission, deducted from your price, halalas' }) commissionHalalas: number;
  @ApiProperty({ description: 'What you receive, halalas' }) payoutHalalas: number;
  @ApiProperty({ description: 'Commission rate applied, basis points' }) commissionRateBps: number;
}

export class QuoteForWorkerDto {
  @ApiProperty() id: string;
  @ApiProperty() bookingId: string;
  @ApiProperty({ description: 'Booking reference' }) bookingReference: string;
  @ApiProperty({ enum: QuoteStatus }) status: QuoteStatus;
  @ApiProperty() version: number;
  @ApiProperty({ type: WorkerMoneyDto }) money: WorkerMoneyDto;
  @ApiProperty() proposedStartAt: string;
  @ApiProperty() proposedEndAt: string;
  @ApiProperty({ nullable: true }) estimatedDurationMinutes: number | null;
  @ApiProperty({ nullable: true }) message: string | null;
  @ApiProperty() validUntil: string;
  @ApiProperty() isExpired: boolean;
  @ApiProperty() createdAt: string;
}

export class PagedWorkerQuotesDto {
  @ApiProperty({ type: [QuoteForWorkerDto] }) items: QuoteForWorkerDto[];
  @ApiProperty({ type: PageMetaDto }) meta: PageMetaDto;
}

export class WorkerRequestSummaryDto {
  @ApiProperty() id: string;
  @ApiProperty() reference: string;
  @ApiProperty({ enum: BookingStatus }) status: BookingStatus;
  @ApiProperty({ type: BookingServiceDto }) service: BookingServiceDto;
  @ApiProperty({ type: BookingLocationDto, description: 'City and district only' }) location: BookingLocationDto;
  @ApiProperty() isUrgent: boolean;
  @ApiProperty() preferredStartAt: string;
  @ApiProperty() preferredEndAt: string;
  @ApiProperty() expiresAt: string;
  @ApiProperty({ type: QuoteForWorkerDto, nullable: true, description: 'Your quote on this request, if any' }) myQuote: QuoteForWorkerDto | null;
  @ApiProperty() createdAt: string;
}

export class PagedWorkerRequestsDto {
  @ApiProperty({ type: [WorkerRequestSummaryDto] }) items: WorkerRequestSummaryDto[];
  @ApiProperty({ type: PageMetaDto }) meta: PageMetaDto;
}

export class WorkerRequestDetailDto extends WorkerRequestSummaryDto {
  @ApiProperty() problemDescription: string;
  @ApiProperty({ type: [BookingPhotoDto] }) photos: BookingPhotoDto[];
}

export class WorkerBookingDto extends WorkerRequestSummaryDto {
  @ApiProperty() problemDescription: string;
  @ApiProperty({ type: WorkerMoneyDto, nullable: true }) money: WorkerMoneyDto | null;
  @ApiProperty({ type: [BookingPhotoDto] }) photos: BookingPhotoDto[];
  @ApiPropertyOptional({ description: 'Customer name; shared once the booking is paid' }) customerName?: string | null;
  @ApiPropertyOptional({ description: 'Customer phone; shared once the booking is paid' }) customerPhone?: string | null;
  @ApiProperty({ enum: ['ONLINE', 'CASH'], nullable: true, description: 'CASH = collect the total from the customer in person' }) paymentMethod: 'ONLINE' | 'CASH' | null;
  @ApiProperty({ nullable: true, description: 'CASH only: when you confirmed receiving the cash' }) cashCollectedAt: string | null;
  @ApiProperty({ nullable: true }) startedAt: string | null;
  @ApiProperty({ nullable: true }) completedAt: string | null;
}

export class PagedWorkerBookingsDto {
  @ApiProperty({ type: [WorkerBookingDto] }) items: WorkerBookingDto[];
  @ApiProperty({ type: PageMetaDto }) meta: PageMetaDto;
}

// ---- admin side

export class AdminBookingDetailDto extends BookingDetailDto {
  @ApiProperty() customerId: string;
  @ApiProperty({ nullable: true }) customerPhone: string | null;
  @ApiProperty({ nullable: true }) workerId: string | null;
  @ApiProperty({ type: WorkerMoneyDto, nullable: true }) fullMoney: WorkerMoneyDto | null;
  @ApiProperty({ type: [QuoteForWorkerDto] }) quotes: QuoteForWorkerDto[];
}
