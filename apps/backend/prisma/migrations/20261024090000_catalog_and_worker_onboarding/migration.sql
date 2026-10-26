-- Service catalog, launch cities, worker onboarding data and verification history.
-- Note: the new enum value 'SUSPENDED' is only used by application code after this migration commits.

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('NATIONAL_ID', 'IQAMA', 'PROFESSIONAL_LICENSE', 'CERTIFICATE', 'PHOTO', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING_UPLOAD', 'UPLOADED', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "VerificationAction" AS ENUM ('SUBMITTED', 'REVIEW_STARTED', 'INFO_REQUESTED', 'APPROVED', 'REJECTED', 'SUSPENDED', 'REINSTATED');

-- AlterEnum
ALTER TYPE "WorkerVerificationStatus" ADD VALUE 'SUSPENDED';

-- CreateTable
CREATE TABLE "cities" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(60) NOT NULL,
    "name_en" VARCHAR(100) NOT NULL,
    "name_ar" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_categories" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(60) NOT NULL,
    "name_en" VARCHAR(100) NOT NULL,
    "name_ar" VARCHAR(100) NOT NULL,
    "description_en" VARCHAR(1000),
    "description_ar" VARCHAR(1000),
    "icon_key" VARCHAR(60),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "name_en" VARCHAR(120) NOT NULL,
    "name_ar" VARCHAR(120) NOT NULL,
    "description_en" VARCHAR(1000),
    "description_ar" VARCHAR(1000),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_services" (
    "worker_profile_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "years_of_experience" SMALLINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_services_pkey" PRIMARY KEY ("worker_profile_id","service_id")
);

-- CreateTable
CREATE TABLE "worker_service_areas" (
    "worker_profile_id" UUID NOT NULL,
    "city_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_service_areas_pkey" PRIMARY KEY ("worker_profile_id","city_id")
);

-- CreateTable
CREATE TABLE "worker_availability" (
    "id" UUID NOT NULL,
    "worker_profile_id" UUID NOT NULL,
    "day_of_week" SMALLINT NOT NULL,
    "start_minute" SMALLINT NOT NULL,
    "end_minute" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_verification_documents" (
    "id" UUID NOT NULL,
    "worker_profile_id" UUID NOT NULL,
    "type" "DocumentType" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "storage_key" VARCHAR(512) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "checksum_sha256" CHAR(64),
    "expires_on" DATE,
    "review_note" VARCHAR(500),
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "worker_verification_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_verification_events" (
    "id" UUID NOT NULL,
    "worker_profile_id" UUID NOT NULL,
    "action" "VerificationAction" NOT NULL,
    "from_status" "WorkerVerificationStatus" NOT NULL,
    "to_status" "WorkerVerificationStatus" NOT NULL,
    "actor_user_id" UUID,
    "reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_verification_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cities_slug_key" ON "cities"("slug");

-- CreateIndex
CREATE INDEX "cities_is_active_sort_order_idx" ON "cities"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "service_categories_slug_key" ON "service_categories"("slug");

-- CreateIndex
CREATE INDEX "service_categories_is_active_sort_order_idx" ON "service_categories"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "services_slug_key" ON "services"("slug");

-- CreateIndex
CREATE INDEX "services_category_id_is_active_sort_order_idx" ON "services"("category_id", "is_active", "sort_order");

-- CreateIndex
CREATE INDEX "worker_services_service_id_idx" ON "worker_services"("service_id");

-- CreateIndex
CREATE INDEX "worker_service_areas_city_id_idx" ON "worker_service_areas"("city_id");

-- CreateIndex
CREATE INDEX "worker_availability_worker_profile_id_idx" ON "worker_availability"("worker_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "worker_availability_worker_profile_id_day_of_week_start_min_key" ON "worker_availability"("worker_profile_id", "day_of_week", "start_minute");

-- CreateIndex
CREATE UNIQUE INDEX "worker_verification_documents_storage_key_key" ON "worker_verification_documents"("storage_key");

-- CreateIndex
CREATE INDEX "worker_verification_documents_worker_profile_id_type_idx" ON "worker_verification_documents"("worker_profile_id", "type");

-- CreateIndex
CREATE INDEX "worker_verification_documents_reviewed_by_id_idx" ON "worker_verification_documents"("reviewed_by_id");

-- CreateIndex
CREATE INDEX "worker_verification_events_worker_profile_id_created_at_idx" ON "worker_verification_events"("worker_profile_id", "created_at");

-- CreateIndex
CREATE INDEX "worker_verification_events_actor_user_id_idx" ON "worker_verification_events"("actor_user_id");

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_services" ADD CONSTRAINT "worker_services_worker_profile_id_fkey" FOREIGN KEY ("worker_profile_id") REFERENCES "worker_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_services" ADD CONSTRAINT "worker_services_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_service_areas" ADD CONSTRAINT "worker_service_areas_worker_profile_id_fkey" FOREIGN KEY ("worker_profile_id") REFERENCES "worker_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_service_areas" ADD CONSTRAINT "worker_service_areas_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_availability" ADD CONSTRAINT "worker_availability_worker_profile_id_fkey" FOREIGN KEY ("worker_profile_id") REFERENCES "worker_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_verification_documents" ADD CONSTRAINT "worker_verification_documents_worker_profile_id_fkey" FOREIGN KEY ("worker_profile_id") REFERENCES "worker_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_verification_documents" ADD CONSTRAINT "worker_verification_documents_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_verification_events" ADD CONSTRAINT "worker_verification_events_worker_profile_id_fkey" FOREIGN KEY ("worker_profile_id") REFERENCES "worker_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_verification_events" ADD CONSTRAINT "worker_verification_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Data-integrity rules Prisma cannot express.
ALTER TABLE "worker_availability" ADD CONSTRAINT "worker_availability_day_check" CHECK ("day_of_week" BETWEEN 0 AND 6);
ALTER TABLE "worker_availability" ADD CONSTRAINT "worker_availability_minutes_check" CHECK ("start_minute" >= 0 AND "end_minute" <= 1440 AND "start_minute" < "end_minute");
ALTER TABLE "worker_services" ADD CONSTRAINT "worker_services_experience_check" CHECK ("years_of_experience" IS NULL OR "years_of_experience" BETWEEN 0 AND 60);
ALTER TABLE "worker_verification_documents" ADD CONSTRAINT "worker_verification_documents_size_check" CHECK ("size_bytes" > 0);
