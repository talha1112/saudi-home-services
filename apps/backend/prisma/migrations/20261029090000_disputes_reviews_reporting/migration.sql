-- Phase 9: disputes, reviews (with cached worker rating columns) and the indexes the new reports need.
-- Generated DDL first; hand-written CHECKs, triggers and partial indexes at the end. Additive only:
-- two defaulted columns on worker_profiles, new tables, new indexes. No existing data is changed.

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'AWAITING_INFO', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "DisputeCategory" AS ENUM ('SERVICE_QUALITY', 'NO_SHOW', 'PRICING', 'PAYMENT', 'CONDUCT', 'OTHER');

-- CreateEnum
CREATE TYPE "DisputeFinancialFollowup" AS ENUM ('NONE', 'REQUESTED');

-- CreateEnum
CREATE TYPE "DisputeVisibility" AS ENUM ('PARTICIPANTS', 'INTERNAL');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PUBLISHED', 'HIDDEN', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "worker_profiles" ADD COLUMN     "rating_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rating_sum" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "disputes" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "opened_by_id" UUID NOT NULL,
    "opened_by_role" "Role" NOT NULL,
    "category" "DisputeCategory" NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "assigned_admin_id" UUID,
    "resolution_summary" VARCHAR(2000),
    "financial_followup" "DisputeFinancialFollowup" NOT NULL DEFAULT 'NONE',
    "reopen_count" INTEGER NOT NULL DEFAULT 0,
    "resolved_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_events" (
    "id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "action" VARCHAR(24) NOT NULL,
    "from_status" "DisputeStatus",
    "to_status" "DisputeStatus",
    "actor_user_id" UUID,
    "actor_role" "Role",
    "visibility" "DisputeVisibility" NOT NULL DEFAULT 'PARTICIPANTS',
    "note" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_evidence" (
    "id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "booking_photo_id" UUID,
    "chat_message_id" UUID,
    "added_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "worker_profile_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" VARCHAR(1000),
    "status" "ReviewStatus" NOT NULL DEFAULT 'PUBLISHED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_events" (
    "id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "action" VARCHAR(16) NOT NULL,
    "from_status" "ReviewStatus",
    "to_status" "ReviewStatus" NOT NULL,
    "actor_user_id" UUID,
    "actor_role" "Role" NOT NULL,
    "reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "disputes_booking_id_idx" ON "disputes"("booking_id");

-- CreateIndex
CREATE INDEX "disputes_status_created_at_idx" ON "disputes"("status", "created_at");

-- CreateIndex
CREATE INDEX "disputes_opened_by_id_idx" ON "disputes"("opened_by_id");

-- CreateIndex
CREATE INDEX "disputes_assigned_admin_id_status_idx" ON "disputes"("assigned_admin_id", "status");

-- CreateIndex
CREATE INDEX "dispute_events_dispute_id_created_at_idx" ON "dispute_events"("dispute_id", "created_at");

-- CreateIndex
CREATE INDEX "dispute_evidence_booking_photo_id_idx" ON "dispute_evidence"("booking_photo_id");

-- CreateIndex
CREATE INDEX "dispute_evidence_chat_message_id_idx" ON "dispute_evidence"("chat_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "dispute_evidence_dispute_id_booking_photo_id_key" ON "dispute_evidence"("dispute_id", "booking_photo_id");

-- CreateIndex
CREATE UNIQUE INDEX "dispute_evidence_dispute_id_chat_message_id_key" ON "dispute_evidence"("dispute_id", "chat_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_booking_id_key" ON "reviews"("booking_id");

-- CreateIndex
CREATE INDEX "reviews_worker_profile_id_status_created_at_idx" ON "reviews"("worker_profile_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "reviews_status_created_at_idx" ON "reviews"("status", "created_at");

-- CreateIndex
CREATE INDEX "reviews_customer_id_idx" ON "reviews"("customer_id");

-- CreateIndex
CREATE INDEX "review_events_review_id_created_at_idx" ON "review_events"("review_id", "created_at");

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_opened_by_id_fkey" FOREIGN KEY ("opened_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_assigned_admin_id_fkey" FOREIGN KEY ("assigned_admin_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_events" ADD CONSTRAINT "dispute_events_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_events" ADD CONSTRAINT "dispute_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_booking_photo_id_fkey" FOREIGN KEY ("booking_photo_id") REFERENCES "booking_photos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_chat_message_id_fkey" FOREIGN KEY ("chat_message_id") REFERENCES "chat_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_worker_profile_id_fkey" FOREIGN KEY ("worker_profile_id") REFERENCES "worker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Hand-written invariants
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "worker_profiles"
  ADD CONSTRAINT "worker_profiles_rating_ck" CHECK (
    "rating_count" >= 0 AND "rating_sum" >= "rating_count" AND "rating_sum" <= 5 * "rating_count"
  );

-- ---- disputes
ALTER TABLE "disputes"
  ADD CONSTRAINT "disputes_opener_role_ck" CHECK ("opened_by_role" IN ('CUSTOMER', 'WORKER')),
  ADD CONSTRAINT "disputes_description_ck" CHECK (length(btrim("description")) > 0),
  ADD CONSTRAINT "disputes_reopen_ck" CHECK ("reopen_count" >= 0),
  ADD CONSTRAINT "disputes_resolved_ck" CHECK ("status" <> 'RESOLVED' OR ("resolution_summary" IS NOT NULL AND "resolved_at" IS NOT NULL));

-- At most one ACTIVE dispute per booking: PostgreSQL itself refuses a second one.
CREATE UNIQUE INDEX "disputes_one_active_per_booking_idx" ON "disputes" ("booking_id")
  WHERE "status" IN ('OPEN', 'UNDER_REVIEW', 'AWAITING_INFO');

-- Only the booking's customer or its assigned worker can open a dispute, with the matching role.
CREATE FUNCTION disputes_check_opener() RETURNS trigger AS $$
DECLARE
  b_customer uuid;
  b_worker_user uuid;
BEGIN
  SELECT bk."customer_id", wp."user_id" INTO b_customer, b_worker_user
    FROM "bookings" bk LEFT JOIN "worker_profiles" wp ON wp."id" = bk."worker_profile_id"
    WHERE bk."id" = NEW."booking_id";
  IF NEW."opened_by_role" = 'CUSTOMER' AND NEW."opened_by_id" IS NOT DISTINCT FROM b_customer THEN
    RETURN NEW;
  END IF;
  IF NEW."opened_by_role" = 'WORKER' AND b_worker_user IS NOT NULL AND NEW."opened_by_id" = b_worker_user THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a dispute can only be opened by a participant of the booking';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER disputes_opener_check BEFORE INSERT ON "disputes" FOR EACH ROW EXECUTE FUNCTION disputes_check_opener();

-- The booking, opener, category and description never change.
CREATE FUNCTION disputes_keep_identity() RETURNS trigger AS $$
BEGIN
  IF NEW."booking_id" <> OLD."booking_id" OR NEW."opened_by_id" <> OLD."opened_by_id" OR NEW."opened_by_role" <> OLD."opened_by_role"
     OR NEW."category" <> OLD."category" OR NEW."description" <> OLD."description" THEN
    RAISE EXCEPTION 'the booking, opener, category and description of a dispute cannot change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER disputes_identity_guard BEFORE UPDATE ON "disputes" FOR EACH ROW EXECUTE FUNCTION disputes_keep_identity();

ALTER TABLE "dispute_events" ADD CONSTRAINT "dispute_events_note_ck" CHECK ("note" IS NULL OR length(btrim("note")) > 0);

CREATE FUNCTION history_rows_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER dispute_events_immutable BEFORE UPDATE OR DELETE ON "dispute_events" FOR EACH ROW EXECUTE FUNCTION history_rows_immutable();
CREATE TRIGGER review_events_immutable BEFORE UPDATE OR DELETE ON "review_events" FOR EACH ROW EXECUTE FUNCTION history_rows_immutable();

-- ---- dispute evidence: exactly one reference, and it must belong to the dispute's booking
ALTER TABLE "dispute_evidence"
  ADD CONSTRAINT "dispute_evidence_one_ref_ck" CHECK (("booking_photo_id" IS NULL) <> ("chat_message_id" IS NULL));

CREATE FUNCTION dispute_evidence_same_booking() RETURNS trigger AS $$
DECLARE
  d_booking uuid;
  e_booking uuid;
BEGIN
  SELECT "booking_id" INTO d_booking FROM "disputes" WHERE "id" = NEW."dispute_id";
  IF NEW."booking_photo_id" IS NOT NULL THEN
    SELECT "booking_id" INTO e_booking FROM "booking_photos" WHERE "id" = NEW."booking_photo_id";
  ELSE
    SELECT "booking_id" INTO e_booking FROM "chat_messages" WHERE "id" = NEW."chat_message_id";
  END IF;
  IF e_booking IS DISTINCT FROM d_booking THEN
    RAISE EXCEPTION 'evidence must belong to the booking of the dispute';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER dispute_evidence_booking_check BEFORE INSERT ON "dispute_evidence" FOR EACH ROW EXECUTE FUNCTION dispute_evidence_same_booking();

-- ---- reviews
ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_rating_ck" CHECK ("rating" BETWEEN 1 AND 5),
  ADD CONSTRAINT "reviews_comment_ck" CHECK ("comment" IS NULL OR length(btrim("comment")) > 0);

-- Only the customer of a COMPLETED booking can review the worker who did it, never themselves.
CREATE FUNCTION reviews_check_eligibility() RETURNS trigger AS $$
DECLARE
  b_status "BookingStatus";
  b_customer uuid;
  b_worker uuid;
  w_user uuid;
BEGIN
  SELECT bk."status", bk."customer_id", bk."worker_profile_id" INTO b_status, b_customer, b_worker FROM "bookings" bk WHERE bk."id" = NEW."booking_id";
  SELECT "user_id" INTO w_user FROM "worker_profiles" WHERE "id" = NEW."worker_profile_id";
  IF b_status IS DISTINCT FROM 'COMPLETED' THEN RAISE EXCEPTION 'only a completed booking can be reviewed'; END IF;
  IF NEW."customer_id" IS DISTINCT FROM b_customer OR NEW."worker_profile_id" IS DISTINCT FROM b_worker THEN
    RAISE EXCEPTION 'a review must come from the booking customer about the booking worker';
  END IF;
  IF w_user = NEW."customer_id" THEN RAISE EXCEPTION 'a worker cannot review their own service'; END IF;
  IF NEW."status" <> 'PUBLISHED' THEN RAISE EXCEPTION 'a new review is published'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER reviews_eligibility_check BEFORE INSERT ON "reviews" FOR EACH ROW EXECUTE FUNCTION reviews_check_eligibility();

-- Content and people are fixed; a withdrawn review is final.
CREATE FUNCTION reviews_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW."rating" <> OLD."rating" OR NEW."comment" IS DISTINCT FROM OLD."comment" OR NEW."booking_id" <> OLD."booking_id"
     OR NEW."customer_id" <> OLD."customer_id" OR NEW."worker_profile_id" <> OLD."worker_profile_id" THEN
    RAISE EXCEPTION 'the content of a review cannot be changed';
  END IF;
  IF NEW."status" <> OLD."status" AND OLD."status" = 'WITHDRAWN' THEN
    RAISE EXCEPTION 'a withdrawn review is final';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER reviews_update_guard BEFORE UPDATE ON "reviews" FOR EACH ROW EXECUTE FUNCTION reviews_guard_update();

CREATE FUNCTION reviews_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'reviews are never deleted; withdraw or hide them';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER reviews_no_delete BEFORE DELETE ON "reviews" FOR EACH ROW EXECUTE FUNCTION reviews_no_delete();

-- ---------------------------------------------------------------------------------------------
-- Indexes for the date-range reports (existing indexes lead with status/customer, so they cannot serve these)
-- ---------------------------------------------------------------------------------------------
CREATE INDEX "bookings_created_at_idx" ON "bookings" ("created_at");
CREATE INDEX "bookings_completed_at_idx" ON "bookings" ("completed_at") WHERE "completed_at" IS NOT NULL;
CREATE INDEX "bookings_cancelled_at_idx" ON "bookings" ("cancelled_at") WHERE "cancelled_at" IS NOT NULL;
CREATE INDEX "quotes_created_at_idx" ON "quotes" ("created_at");
