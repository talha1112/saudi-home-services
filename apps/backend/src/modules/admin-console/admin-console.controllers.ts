import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PageQueryDto } from '../../common/pagination/pagination.js';
import { Role } from '../../generated/prisma/client.js';
import { AdminCatalogStatsService } from './admin-catalog-stats.service.js';
import { AdminCommissionsService } from './admin-commissions.service.js';
import { ReportSeriesQueryDto, ReportSummaryQueryDto, BroadcastDto, CampaignsQueryDto, CommissionsQueryDto, ConsoleRangeQueryDto, CustomersQueryDto, QuotesQueryDto, ReachQueryDto, SearchQueryDto } from './admin-console.dto.js';
import { AdminCustomersService } from './admin-customers.service.js';
import { AdminDashboardService } from './admin-dashboard.service.js';
import { AdminNotificationsService } from './admin-notifications.service.js';
import { AdminQuotesService } from './admin-quotes.service.js';
import { AdminReportsService } from './admin-reports.service.js';
import { AdminSearchService } from './admin-search.service.js';
import { AdminSystemService } from './admin-system.service.js';
import { AdminTransactionsService, TransactionsQueryDto } from './admin-transactions.service.js';

const uuid = () => new ParseUUIDPipe();

@ApiTags('Admin console')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/dashboard', version: '1' })
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  @Get()
  @ApiOperation({ summary: 'The overview: headline numbers, trend, categories, cities, top workers and queues for a date window and city' })
  get(@Query() q: ConsoleRangeQueryDto) {
    return this.dashboard.dashboard(q);
  }
}

@ApiTags('Admin console')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/customers', version: '1' })
export class AdminCustomersController {
  constructor(private readonly customers: AdminCustomersService) {}

  @Get()
  @ApiOperation({ summary: 'Customers with bookings, spend, last booking and disputes (filters: q, status, hasDisputes, spend range, city)' })
  list(@Query() q: CustomersQueryDto) {
    return this.customers.list(q);
  }

  @Get('summary')
  @ApiOperation({ summary: 'Head-counts for the customers screen' })
  summary() {
    return this.customers.summary();
  }

  @Get(':userId')
  @ApiOperation({ summary: 'One customer: account, booking history, disputes and payment methods' })
  detail(@Param('userId', uuid()) userId: string) {
    return this.customers.detail(userId);
  }
}

@ApiTags('Admin console')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/quotes', version: '1' })
export class AdminQuotesController {
  constructor(private readonly quotes: AdminQuotesService) {}

  @Get()
  @ApiOperation({ summary: 'Every quote (filters: q, status, workerId, created range)' })
  list(@Query() q: QuotesQueryDto) {
    return this.quotes.list(q);
  }

  @Get('summary')
  @ApiOperation({ summary: 'Quote activity for a window: sent, accepted, expired, quotes per request, first response time' })
  summary(@Query() q: ConsoleRangeQueryDto) {
    return this.quotes.summary(q.from, q.to, q.cityId);
  }
}

@ApiTags('Admin console')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/search', version: '1' })
export class AdminSearchController {
  constructor(private readonly search: AdminSearchService) {}

  @Get()
  @RateLimit({ name: 'admin-search', limit: 120, windowSeconds: 60 })
  @ApiOperation({ summary: 'A few customers, workers, bookings, services and disputes matching the text' })
  get(@Query() q: SearchQueryDto) {
    return this.search.search(q.q);
  }
}

@ApiTags('Admin console')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/commissions', version: '1' })
export class AdminCommissionsController {
  constructor(private readonly commissions: AdminCommissionsService) {}

  @Get()
  @ApiOperation({ summary: 'Commission and worker earnings from completed bookings in a window, with the current rule' })
  get(@Query() q: CommissionsQueryDto) {
    return this.commissions.report(q);
  }

  @Get('workers')
  @ApiOperation({ summary: 'Per-worker commission and earnings from completed bookings in a window (paged, searchable by name)' })
  workers(@Query() q: CommissionsQueryDto) {
    return this.commissions.workers(q);
  }
}

@ApiTags('Admin console')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/notifications', version: '1' })
export class AdminNotificationsController {
  constructor(private readonly notifications: AdminNotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Announcements sent so far, newest first, with how many people they reached and how many opened them' })
  list(@Query() q: CampaignsQueryDto) {
    return this.notifications.campaigns(q);
  }

  @Get('summary')
  @ApiOperation({ summary: 'Announcement and push figures for the notifications screen' })
  summary() {
    return this.notifications.summary();
  }

  @Get('reach')
  @ApiOperation({ summary: 'How many people an audience means right now' })
  reach(@Query() q: ReachQueryDto) {
    return this.notifications.reach(q);
  }

  @Post('broadcast')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'admin-broadcast', limit: 20, windowSeconds: 3600 })
  @ApiOperation({ summary: 'Send an announcement to an audience now (at most 5,000 people). Audited.' })
  broadcast(@CurrentUser() admin: AuthenticatedUser, @Body() dto: BroadcastDto) {
    return this.notifications.broadcast(admin, dto);
  }
}

@ApiTags('Admin console')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin', version: '1' })
export class AdminSystemController {
  constructor(private readonly system: AdminSystemService) {}

  @Get('admins')
  @ApiOperation({ summary: 'Administrator accounts (read-only; they are created and removed with the command-line tool)' })
  admins() {
    return this.system.admins();
  }

  @Get('system')
  @ApiOperation({ summary: 'Non-secret facts about this deployment: cities, booking limits, payment and push modes' })
  overview() {
    return this.system.overview();
  }
}

@ApiTags('Admin console')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/transactions', version: '1' })
export class AdminTransactionsController {
  constructor(private readonly transactions: AdminTransactionsService) {}

  @Get()
  @ApiOperation({ summary: 'Payments by booking (cash and online), refund requests or failed online attempts (view=transactions|refunds|failed)' })
  list(@Query() q: TransactionsQueryDto) {
    return this.transactions.list(q);
  }

  @Get('summary')
  @ApiOperation({ summary: 'Money figures for a window: agreed amounts, VAT, cash still to collect, refund requests, failed attempts' })
  summary(@Query() q: ConsoleRangeQueryDto) {
    return this.transactions.summary(q.from, q.to, q.cityId);
  }
}

@ApiTags('Admin console')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/catalog-stats', version: '1' })
export class AdminCatalogStatsController {
  constructor(private readonly stats: AdminCatalogStatsService) {}

  @Get()
  @ApiOperation({ summary: 'Bookings, workers and average quote per service and category (all time)' })
  get() {
    return this.stats.stats();
  }
}

@ApiTags('Admin console')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller({ path: 'admin/report-series', version: '1' })
export class AdminReportSeriesController {
  constructor(private readonly reports: AdminReportsService) {}

  @Get()
  @ApiOperation({ summary: 'A report by month and city for the last N months (the chart)' })
  series(@Query() q: ReportSeriesQueryDto) {
    return this.reports.series(q.metric, q.months ?? 6);
  }

  @Get('summary')
  @ApiOperation({ summary: 'The four headline figures of one report for a date window' })
  summary(@Query() q: ReportSummaryQueryDto) {
    return this.reports.summary(q.metric, q.from, q.to);
  }

  @Get('cities')
  @ApiOperation({ summary: 'One row per city for a date window: bookings, revenue, commission, earnings, cancellations, refunds, disputes, rating' })
  cities(@Query() q: ConsoleRangeQueryDto) {
    return this.reports.cities(q.from, q.to);
  }
}
