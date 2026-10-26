-- Bookings, quotations, booking timeline, cancellations, photos metadata and versioned pricing settings.
-- All money is stored as integer halalas and rates as integer basis points.

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('OPEN', 'PAYMENT_PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('SUBMITTED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CancellationReason" AS ENUM ('CHANGED_MIND', 'FOUND_ALTERNATIVE', 'PRICE_TOO_HIGH', 'SCHEDULE_CONFLICT', 'PROBLEM_RESOLVED', 'DUPLICATE_REQUEST', 'OTHER', 'ADMIN_ACTION');

-- CreateEnum
CREATE TYPE "BookingEventType" AS ENUM ('BOOKING_CREATED', 'QUOTE_SUBMITTED', 'QUOTE_REVISED', 'QUOTE_WITHDRAWN', 'QUOTE_ACCEPTED', 'QUOTE_REJECTED', 'QUOTE_EXPIRED', 'PAYMENT_CONFIRMED', 'WORK_STARTED', 'WORK_COMPLETED', 'BOOKING_CANCELLED', 'BOOKING_EXPIRED');

-- CreateEnum
CREATE TYPE "PhotoStatus" AS ENUM ('PENDING_UPLOAD', 'UPLOADED');

-- CreateTable
CREATE TABLE "pricing_settings" (
    "id" UUID NOT NULL,
    "vat_rate_bps" INTEGER NOT NULL,
    "commission_rate_bps" INTEGER NOT NULL,
    "min_service_charge_halalas" INTEGER NOT NULL,
    "is_provisional" BOOLEAN NOT NULL DEFAULT false,
    "note" VARCHAR(500),
    "effective_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(16) NOT NULL,
    "customer_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "city_id" UUID NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'OPEN',
    "problem_description" VARCHAR(2000) NOT NULL,
    "is_urgent" BOOLEAN NOT NULL DEFAULT false,
    "preferred_start_at" TIMESTAMPTZ(3) NOT NULL,
    "preferred_end_at" TIMESTAMPTZ(3) NOT NULL,
    "district" VARCHAR(120),
    "address_line" VARCHAR(255) NOT NULL,
    "building" VARCHAR(120),
    "location_notes" VARCHAR(500),
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_quote_id" UUID,
    "worker_profile_id" UUID,
    "accepted_at" TIMESTAMPTZ(3),
    "payment_due_at" TIMESTAMPTZ(3),
    "confirmed_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "currency" VARCHAR(3) NOT NULL DEFAULT 'SAR',
    "service_amount_halalas" INTEGER,
    "vat_amount_halalas" INTEGER,
    "total_amount_halalas" INTEGER,
    "commission_amount_halalas" INTEGER,
    "worker_payout_halalas" INTEGER,
    "vat_rate_bps" INTEGER,
    "commission_rate_bps" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "worker_profile_id" UUID NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'SUBMITTED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "price_halalas" INTEGER NOT NULL,
    "proposed_start_at" TIMESTAMPTZ(3) NOT NULL,
    "proposed_end_at" TIMESTAMPTZ(3) NOT NULL,
    "estimated_duration_minutes" SMALLINT,
    "message" VARCHAR(1000),
    "valid_until" TIMESTAMPTZ(3) NOT NULL,
    "pricing_setting_id" UUID NOT NULL,
    "vat_rate_bps" INTEGER NOT NULL,
    "commission_rate_bps" INTEGER NOT NULL,
    "vat_amount_halalas" INTEGER NOT NULL,
    "total_amount_halalas" INTEGER NOT NULL,
    "commission_amount_halalas" INTEGER NOT NULL,
    "worker_payout_halalas" INTEGER NOT NULL,
    "is_accepted" BOOLEAN,
    "accepted_at" TIMESTAMPTZ(3),
    "withdrawn_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_events" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "type" "BookingEventType" NOT NULL,
    "from_status" "BookingStatus",
    "to_status" "BookingStatus",
    "quote_id" UUID,
    "actor_user_id" UUID,
    "actor_role" "Role",
    "amount_halalas" INTEGER,
    "note" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_photos" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "status" "PhotoStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "storage_key" VARCHAR(512) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_cancellations" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "cancelled_by_user_id" UUID,
    "cancelled_by_role" "Role" NOT NULL,
    "reason" "CancellationReason" NOT NULL,
    "note" VARCHAR(500),
    "previous_status" "BookingStatus" NOT NULL,
    "cancelled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_cancellations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pricing_settings_effective_from_idx" ON "pricing_settings"("effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_reference_key" ON "bookings"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_accepted_quote_id_key" ON "bookings"("accepted_quote_id");

-- CreateIndex
CREATE INDEX "bookings_customer_id_status_created_at_idx" ON "bookings"("customer_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "bookings_status_city_id_service_id_created_at_idx" ON "bookings"("status", "city_id", "service_id", "created_at");

-- CreateIndex
CREATE INDEX "bookings_status_expires_at_idx" ON "bookings"("status", "expires_at");

-- CreateIndex
CREATE INDEX "bookings_worker_profile_id_status_idx" ON "bookings"("worker_profile_id", "status");

-- CreateIndex
CREATE INDEX "quotes_worker_profile_id_status_idx" ON "quotes"("worker_profile_id", "status");

-- CreateIndex
CREATE INDEX "quotes_booking_id_status_idx" ON "quotes"("booking_id", "status");

-- CreateIndex
CREATE INDEX "quotes_status_valid_until_idx" ON "quotes"("status", "valid_until");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_booking_id_worker_profile_id_key" ON "quotes"("booking_id", "worker_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_booking_id_is_accepted_key" ON "quotes"("booking_id", "is_accepted");

-- CreateIndex
CREATE INDEX "booking_events_booking_id_created_at_idx" ON "booking_events"("booking_id", "created_at");

-- CreateIndex
CREATE INDEX "booking_events_quote_id_idx" ON "booking_events"("quote_id");

-- CreateIndex
CREATE INDEX "booking_events_actor_user_id_idx" ON "booking_events"("actor_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "booking_photos_storage_key_key" ON "booking_photos"("storage_key");

-- CreateIndex
CREATE INDEX "booking_photos_booking_id_idx" ON "booking_photos"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "booking_cancellations_booking_id_key" ON "booking_cancellations"("booking_id");

-- CreateIndex
CREATE INDEX "booking_cancellations_cancelled_by_user_id_idx" ON "booking_cancellations"("cancelled_by_user_id");

-- AddForeignKey
ALTER TABLE "pricing_settings" ADD CONSTRAINT "pricing_settings_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_worker_profile_id_fkey" FOREIGN KEY ("worker_profile_id") REFERENCES "worker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_accepted_quote_id_fkey" FOREIGN KEY ("accepted_quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_worker_profile_id_fkey" FOREIGN KEY ("worker_profile_id") REFERENCES "worker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_pricing_setting_id_fkey" FOREIGN KEY ("pricing_setting_id") REFERENCES "pricing_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_photos" ADD CONSTRAINT "booking_photos_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_cancellations" ADD CONSTRAINT "booking_cancellations_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_cancellations" ADD CONSTRAINT "booking_cancellations_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Integrity rules that Prisma cannot express. The application enforces the same rules;
-- these make PostgreSQL refuse inconsistent rows even if a bug or a manual edit tries.
-- ---------------------------------------------------------------------------

-- Pricing settings: sane rates (basis points) and a non-negative minimum.
ALTER TABLE "pricing_settings" ADD CONSTRAINT "pricing_settings_rates_check"
  CHECK ("vat_rate_bps" BETWEEN 0 AND 5000 AND "commission_rate_bps" BETWEEN 0 AND 5000 AND "min_service_charge_halalas" >= 0);

-- Bookings: schedule window, money identities, and "no accepted-state without a quote and a worker".
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_window_check" CHECK ("preferred_end_at" > "preferred_start_at");
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_location_check"
  CHECK (("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90) AND ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180));
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_assignment_check"
  CHECK ("status" NOT IN ('PAYMENT_PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED')
         OR ("accepted_quote_id" IS NOT NULL AND "worker_profile_id" IS NOT NULL
             AND "service_amount_halalas" IS NOT NULL AND "total_amount_halalas" IS NOT NULL));
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_money_check"
  CHECK ("service_amount_halalas" IS NULL
         OR ("service_amount_halalas" > 0
             AND "vat_amount_halalas" >= 0
             AND "total_amount_halalas" = "service_amount_halalas" + "vat_amount_halalas"
             AND "commission_amount_halalas" >= 0
             AND "worker_payout_halalas" = "service_amount_halalas" - "commission_amount_halalas"
             AND "worker_payout_halalas" >= 0));

-- Quotes: the same identities, a sane time window, and "accepted flag mirrors accepted status".
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_money_check"
  CHECK ("price_halalas" > 0
         AND "vat_amount_halalas" >= 0
         AND "total_amount_halalas" = "price_halalas" + "vat_amount_halalas"
         AND "commission_amount_halalas" >= 0
         AND "worker_payout_halalas" = "price_halalas" - "commission_amount_halalas"
         AND "worker_payout_halalas" >= 0
         AND "vat_rate_bps" BETWEEN 0 AND 5000 AND "commission_rate_bps" BETWEEN 0 AND 5000);
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_window_check" CHECK ("proposed_end_at" > "proposed_start_at");
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_accepted_flag_check"
  CHECK (("status" = 'ACCEPTED') = COALESCE("is_accepted", false));
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_duration_check"
  CHECK ("estimated_duration_minutes" IS NULL OR "estimated_duration_minutes" > 0);

-- Photos: positive size.
ALTER TABLE "booking_photos" ADD CONSTRAINT "booking_photos_size_check" CHECK ("size_bytes" > 0);
