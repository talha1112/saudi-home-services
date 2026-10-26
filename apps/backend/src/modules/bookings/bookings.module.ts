import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { BookingLifecycleService } from './booking-lifecycle.service.js';
import { BookingMaintenanceService } from './booking-maintenance.service.js';
import { BookingPhotosService } from './booking-photos.service.js';
import { BookingsQueryService } from './bookings-query.service.js';
import { AdminBookingsController, CustomerBookingsController, WorkerBookingsController } from './bookings.controllers.js';
import { QuotesService } from './quotes.service.js';

@Module({
  imports: [AuthModule, PricingModule, StorageModule],
  controllers: [CustomerBookingsController, WorkerBookingsController, AdminBookingsController],
  providers: [BookingLifecycleService, QuotesService, BookingsQueryService, BookingPhotosService, BookingMaintenanceService],
  // Exported so the payments phase can call BookingLifecycleService.confirmPayment().
  exports: [BookingLifecycleService, BookingsQueryService],
})
export class BookingsModule {}
