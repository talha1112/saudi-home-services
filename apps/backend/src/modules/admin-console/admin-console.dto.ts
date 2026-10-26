import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PageQueryDto, toOptionalBoolean } from '../../common/pagination/pagination.js';
import { QuoteStatus, UserStatus } from '../../generated/prisma/client.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const csv = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value);

/** A date window (from inclusive, to exclusive) and an optional city, shared by the dashboard and the commissions report. */
export class ConsoleRangeQueryDto {
  @ApiPropertyOptional({ description: 'Inclusive start (ISO 8601). Default: 30 days before `to`.' }) @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @ApiPropertyOptional({ description: 'Exclusive end (ISO 8601). Default: now.' }) @IsOptional() @IsISO8601({ strict: true }) to?: string;
  @ApiPropertyOptional({ description: 'Only bookings in this city' }) @IsOptional() @IsUUID() cityId?: string;
}

export class CustomersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Name, phone or e-mail' }) @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) q?: string;
  @ApiPropertyOptional({ enum: UserStatus }) @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
  @ApiPropertyOptional({ description: 'Only customers with at least one dispute (true) or none (false)' }) @IsOptional() @Transform(toOptionalBoolean) @IsBoolean() hasDisputes?: boolean;
  @ApiPropertyOptional({ description: 'Minimum total spent, halalas' }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) minSpentHalalas?: number;
  @ApiPropertyOptional({ description: 'Maximum total spent (exclusive), halalas' }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) maxSpentHalalas?: number;
  @ApiPropertyOptional({ description: 'Only customers whose last booking was in this city' }) @IsOptional() @IsUUID() cityId?: string;
}

export class QuotesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Booking reference, worker or service name' }) @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) q?: string;
  @ApiPropertyOptional({ enum: ['PENDING', ...Object.values(QuoteStatus)], description: 'PENDING = submitted and still valid; EXPIRED also covers submitted quotes whose validity ran out' })
  @IsOptional()
  @IsIn(['PENDING', ...Object.values(QuoteStatus)])
  status?: string;
  @ApiPropertyOptional({ description: 'Worker profile id' }) @IsOptional() @IsUUID() workerId?: string;
  @ApiPropertyOptional({ description: 'Only quotes on bookings in this city' }) @IsOptional() @IsUUID() cityId?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true }) to?: string;
}

export class SearchQueryDto {
  @ApiProperty({ description: 'What to look for (2-60 characters)' }) @Transform(trim) @IsString() @MinLength(2) @MaxLength(60) q!: string;
}

export class CommissionsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Worker name' }) @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) q?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true }) to?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() cityId?: string;
}

export const REPORT_METRICS = ['revenue', 'bookings', 'commissions', 'earnings', 'cancellations', 'refunds', 'disputes', 'offers', 'subscriptions', 'customers', 'workers', 'cities'] as const;

export class ReportSeriesQueryDto {
  @ApiProperty({ enum: REPORT_METRICS }) @IsIn(REPORT_METRICS) metric!: (typeof REPORT_METRICS)[number];
  @ApiPropertyOptional({ minimum: 1, maximum: 12, default: 6 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(12) months?: number;
}

export class ReportSummaryQueryDto extends ConsoleRangeQueryDto {
  @ApiProperty({ enum: REPORT_METRICS }) @IsIn(REPORT_METRICS) metric!: (typeof REPORT_METRICS)[number];
}

export const GROUPS = ['ALL', 'NEW', 'INACTIVE', 'REPEAT', 'APPROVED', 'PENDING_VERIFICATION', 'SUSPENDED'] as const;
export type AudienceGroup = (typeof GROUPS)[number];
export const AUDIENCES = ['CUSTOMERS', 'WORKERS'] as const;
export type Audience = (typeof AUDIENCES)[number];

export class ReachQueryDto {
  @ApiProperty({ enum: AUDIENCES }) @IsIn(AUDIENCES) audience!: Audience;
  @ApiPropertyOptional({ enum: GROUPS, description: 'Customers: ALL, NEW (no bookings), INACTIVE (no booking for 60 days), REPEAT. Workers: ALL, APPROVED, PENDING_VERIFICATION, SUSPENDED.' })
  @IsOptional()
  @IsIn(GROUPS)
  group?: AudienceGroup;
  @ApiPropertyOptional({ description: 'Comma-separated city ids. Workers: serve one of them. Customers: have booked in one of them.' }) @IsOptional() @Transform(csv) @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) cityIds?: string[];
  @ApiPropertyOptional({ description: 'Comma-separated category ids. Workers: offer a service in one. Customers: have booked one.' }) @IsOptional() @Transform(csv) @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) categoryIds?: string[];
}

export class CampaignsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Title in either language' }) @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) q?: string;
  @ApiPropertyOptional({ enum: ['SENT', 'SCHEDULED'] }) @IsOptional() @IsIn(['SENT', 'SCHEDULED']) status?: string;
}

export class BroadcastDto {
  @ApiProperty({ enum: AUDIENCES }) @IsIn(AUDIENCES) audience!: Audience;
  @ApiPropertyOptional({ enum: GROUPS }) @IsOptional() @IsIn(GROUPS) group?: AudienceGroup;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) cityIds?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) categoryIds?: string[];
  @ApiPropertyOptional({ maxLength: 40, description: 'What kind of announcement it is (shown in the history)' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(40) kind?: string;
  @ApiPropertyOptional({ maxLength: 80 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(80) titleEn?: string;
  @ApiPropertyOptional({ maxLength: 80 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(80) titleAr?: string;
  @ApiPropertyOptional({ maxLength: 300 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(300) bodyEn?: string;
  @ApiPropertyOptional({ maxLength: 300 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(300) bodyAr?: string;
}
