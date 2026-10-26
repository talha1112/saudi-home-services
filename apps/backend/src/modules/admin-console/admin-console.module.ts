import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { AdminCatalogStatsService } from './admin-catalog-stats.service.js';
import { AdminCommissionsService } from './admin-commissions.service.js';
import {
  AdminCatalogStatsController,
  AdminCommissionsController,
  AdminCustomersController,
  AdminDashboardController,
  AdminNotificationsController,
  AdminQuotesController,
  AdminReportSeriesController,
  AdminSearchController,
  AdminSystemController,
  AdminTransactionsController,
} from './admin-console.controllers.js';
import { AdminCustomersService } from './admin-customers.service.js';
import { AdminDashboardService } from './admin-dashboard.service.js';
import { AdminNotificationsService } from './admin-notifications.service.js';
import { AdminQuotesService } from './admin-quotes.service.js';
import { AdminReportsService } from './admin-reports.service.js';
import { AdminSearchService } from './admin-search.service.js';
import { AdminSystemService } from './admin-system.service.js';
import { AdminTransactionsService } from './admin-transactions.service.js';

/** Read models and a few actions the administrator console needs and no single domain module owns: overview, customers, quotes, search, commissions, announcements. */
@Module({
  imports: [AuthModule, PricingModule],
  controllers: [AdminDashboardController, AdminCustomersController, AdminQuotesController, AdminSearchController, AdminCommissionsController, AdminNotificationsController, AdminSystemController, AdminTransactionsController, AdminCatalogStatsController, AdminReportSeriesController],
  providers: [AdminDashboardService, AdminCustomersService, AdminQuotesService, AdminSearchService, AdminCommissionsService, AdminNotificationsService, AdminSystemService, AdminTransactionsService, AdminCatalogStatsService, AdminReportsService],
})
export class AdminConsoleModule {}
