import { Controller, Get, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { toOptionalBoolean } from '../../common/pagination/pagination.js';
import { Role } from '../../generated/prisma/client.js';
import { ReportsService, resolveRange } from './reports.service.js';

export class RangeQueryDto {
  @ApiPropertyOptional({ description: 'Inclusive start (ISO 8601). Default: 30 days before `to`.' }) @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @ApiPropertyOptional({ description: 'Exclusive end (ISO 8601). Default: now. The range may span at most 366 days.' }) @IsOptional() @IsISO8601({ strict: true }) to?: string;
}

export class BookingsReportQueryDto extends RangeQueryDto {
  @ApiPropertyOptional({ default: 20, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) top?: number;
}

export class TrendQueryDto extends RangeQueryDto {
  @ApiPropertyOptional({ enum: ['day', 'week', 'month'], default: 'day' }) @IsOptional() @IsIn(['day', 'week', 'month']) interval?: 'day' | 'week' | 'month';
}

export class MoneyReportQueryDto extends RangeQueryDto {
  @ApiPropertyOptional({ default: false, description: 'Include SIMULATED (mock provider) payments, refunds and ledger entries. Excluded by default.' })
  @IsOptional() @Transform(toOptionalBoolean) @IsBoolean() includeSimulated?: boolean;
}

/** Read-only administrator reports. See docs/ADMIN_DISPUTES_REVIEWS_REPORTS.md for every metric's definition and sources. */
@ApiTags('Admin reports')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/reports', version: '1' })
export class AdminReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('bookings')
  @ApiOperation({ summary: 'Bookings created in a range by status, service and city; cancellations by reason' })
  bookings(@Query() q: BookingsReportQueryDto) {
    return this.reports.bookings(resolveRange(q.from, q.to), q.top ?? 20);
  }

  @Get('bookings/trend')
  @ApiOperation({ summary: 'Created / completed / cancelled bookings per day, week or month (Asia/Riyadh calendar)' })
  trend(@Query() q: TrendQueryDto) {
    return this.reports.bookingTrend(resolveRange(q.from, q.to), q.interval ?? 'day');
  }

  @Get('quotes')
  @ApiOperation({ summary: 'Quotes submitted, by status, and quotes accepted in the range' })
  quotes(@Query() q: RangeQueryDto) {
    return this.reports.quotes(resolveRange(q.from, q.to));
  }

  @Get('workers')
  @ApiOperation({ summary: 'Worker verification, active and online counts (snapshots) and registrations in the range' })
  workers(@Query() q: RangeQueryDto) {
    return this.reports.workers(resolveRange(q.from, q.to));
  }

  @Get('reviews')
  @ApiOperation({ summary: 'Reviews by status and the rating distribution of published reviews' })
  reviews(@Query() q: RangeQueryDto) {
    return this.reports.reviews(resolveRange(q.from, q.to));
  }

  @Get('disputes')
  @ApiOperation({ summary: 'Disputes opened in the range by status and category' })
  disputes(@Query() q: RangeQueryDto) {
    return this.reports.disputes(resolveRange(q.from, q.to));
  }

  @Get('notifications')
  @ApiOperation({ summary: 'Notifications created/read and external delivery outcomes' })
  notifications(@Query() q: RangeQueryDto) {
    return this.reports.notifications(resolveRange(q.from, q.to));
  }

  @Get('operations')
  @ApiOperation({ summary: 'Items needing attention now: pending/stale/dead outbox events, storage removals, failed deliveries and webhooks, payments awaiting reconciliation' })
  operations() {
    return this.reports.operations();
  }

  @Get('payments')
  @ApiOperation({ summary: 'Payment attempts by status and currency, provider-reported captures, unapplied captures and refund REQUESTS (never reported as completed unless a provider confirmed)' })
  payments(@Query() q: MoneyReportQueryDto) {
    return this.reports.payments(resolveRange(q.from, q.to), q.includeSimulated ?? false);
  }

  @Get('ledger')
  @ApiOperation({ summary: 'Ledger entries posted in the range by type and currency (a record of postings, not a balance or revenue)' })
  ledger(@Query() q: MoneyReportQueryDto) {
    return this.reports.ledger(resolveRange(q.from, q.to), q.includeSimulated ?? false);
  }
}

@Module({ controllers: [AdminReportsController], providers: [ReportsService] })
export class ReportsModule {}
