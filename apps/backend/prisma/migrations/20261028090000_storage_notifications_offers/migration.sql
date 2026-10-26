-- Phase 8: private storage bookkeeping, notifications, device tokens and offers.
-- Generated DDL first; hand-written CHECK constraints and partial indexes at the end (Prisma cannot express them).
-- Only adds columns with defaults to two tables and creates new tables; no data is changed.

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('NOT_SCANNED', 'PENDING', 'CLEAN', 'INFECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('PUSH', 'SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('ANDROID', 'IOS', 'HUAWEI');

-- CreateEnum
CREATE TYPE "PushProviderName" AS ENUM ('FCM', 'APNS', 'HMS');

-- CreateEnum
CREATE TYPE "OfferAudience" AS ENUM ('CUSTOMERS', 'WORKERS', 'ALL');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'PAUSED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "worker_verification_documents" ADD COLUMN     "content_verified_at" TIMESTAMPTZ(3),
ADD COLUMN     "scan_status" "ScanStatus" NOT NULL DEFAULT 'NOT_SCANNED';

-- AlterTable
ALTER TABLE "booking_photos" ADD COLUMN     "content_verified_at" TIMESTAMPTZ(3),
ADD COLUMN     "scan_status" "ScanStatus" NOT NULL DEFAULT 'NOT_SCANNED';

-- CreateTable
CREATE TABLE "storage_deletions" (
    "id" UUID NOT NULL,
    "storage_key" VARCHAR(512) NOT NULL,
    "reason" VARCHAR(40) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "dead_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(120),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "source_key" VARCHAR(120) NOT NULL,
    "params" JSONB NOT NULL,
    "resource_type" VARCHAR(30),
    "resource_id" UUID,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "target_key" VARCHAR(60) NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider_message_id" VARCHAR(200),
    "last_error" VARCHAR(120),
    "sent_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "provider" "PushProviderName" NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "token_ciphertext" TEXT NOT NULL,
    "app_role" "Role" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" UUID NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'DRAFT',
    "audience" "OfferAudience" NOT NULL,
    "title_ar" VARCHAR(150),
    "title_en" VARCHAR(150),
    "description_ar" VARCHAR(1000),
    "description_en" VARCHAR(1000),
    "terms_ar" VARCHAR(2000),
    "terms_en" VARCHAR(2000),
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "city_id" UUID,
    "service_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_events" (
    "id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "action" VARCHAR(20) NOT NULL,
    "from_status" "OfferStatus",
    "to_status" "OfferStatus",
    "actor_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "storage_deletions_storage_key_key" ON "storage_deletions"("storage_key");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_id_idx" ON "notifications"("user_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_source_key_key" ON "notifications"("user_id", "source_key");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_notification_id_target_key_key" ON "notification_deliveries"("notification_id", "target_key");

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_token_hash_key" ON "device_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "device_tokens_user_id_idx" ON "device_tokens"("user_id");

-- CreateIndex
CREATE INDEX "offers_status_starts_at_ends_at_idx" ON "offers"("status", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "offers_city_id_idx" ON "offers"("city_id");

-- CreateIndex
CREATE INDEX "offers_service_id_idx" ON "offers"("service_id");

-- CreateIndex
CREATE INDEX "offer_events_offer_id_created_at_idx" ON "offer_events"("offer_id", "created_at");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_events" ADD CONSTRAINT "offer_events_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_events" ADD CONSTRAINT "offer_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Hand-written constraints and indexes
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "offers"
  ADD CONSTRAINT "offers_window_ck" CHECK ("ends_at" > "starts_at"),
  ADD CONSTRAINT "offers_has_title_ck" CHECK (length(btrim(coalesce("title_ar", ''))) > 0 OR length(btrim(coalesce("title_en", ''))) > 0),
  ADD CONSTRAINT "offers_published_at_ck" CHECK ("status" = 'DRAFT' OR "published_at" IS NOT NULL OR "status" = 'ARCHIVED');
-- Offers visible to people are looked up by status and window.
CREATE INDEX "offers_live_idx" ON "offers" ("starts_at", "ends_at") WHERE "status" = 'PUBLISHED';

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_type_ck" CHECK (length(btrim("type")) > 0),
  ADD CONSTRAINT "notifications_resource_pair_ck" CHECK (("resource_type" IS NULL) = ("resource_id" IS NULL));
-- Unread badge / unread filter.
CREATE INDEX "notifications_unread_idx" ON "notifications" ("user_id", "created_at" DESC) WHERE "read_at" IS NULL;

ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_attempts_ck" CHECK ("attempts" >= 0);
-- The delivery sweeper only looks at queued rows that are due.
CREATE INDEX "notification_deliveries_due_idx" ON "notification_deliveries" ("next_attempt_at") WHERE "status" = 'QUEUED';

CREATE INDEX "device_tokens_active_idx" ON "device_tokens" ("user_id") WHERE "revoked_at" IS NULL;

ALTER TABLE "storage_deletions"
  ADD CONSTRAINT "storage_deletions_attempts_ck" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "storage_deletions_not_both_ck" CHECK ("completed_at" IS NULL OR "dead_at" IS NULL);
CREATE INDEX "storage_deletions_pending_idx" ON "storage_deletions" ("next_attempt_at") WHERE "completed_at" IS NULL AND "dead_at" IS NULL;
CREATE INDEX "storage_deletions_done_idx" ON "storage_deletions" ("created_at") WHERE "completed_at" IS NOT NULL OR "dead_at" IS NOT NULL;
