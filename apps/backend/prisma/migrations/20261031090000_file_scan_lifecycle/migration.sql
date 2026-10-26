-- File scan lifecycle: a queue of malware-scan jobs for confirmed uploads.
-- Additive only: two enums and one new table. No existing table, column or row is changed or read.
-- Safe to apply on a live database (no locks on existing tables).
-- Rollback: DROP TABLE "file_scan_jobs"; DROP TYPE "FileScanJobStatus"; DROP TYPE "FileScanSubject";
-- CreateEnum
CREATE TYPE "FileScanSubject" AS ENUM ('BOOKING_PHOTO', 'WORKER_DOCUMENT');

-- CreateEnum
CREATE TYPE "FileScanJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'DEAD');

-- CreateTable
CREATE TABLE "file_scan_jobs" (
    "id" UUID NOT NULL,
    "storage_key" VARCHAR(512) NOT NULL,
    "subject" "FileScanSubject" NOT NULL,
    "subject_id" UUID NOT NULL,
    "status" "FileScanJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(3),
    "verdict" "ScanStatus",
    "scanner" VARCHAR(40),
    "last_error" VARCHAR(120),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "file_scan_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "file_scan_jobs_storage_key_key" ON "file_scan_jobs"("storage_key");

-- CreateIndex
CREATE INDEX "file_scan_jobs_status_next_attempt_at_idx" ON "file_scan_jobs"("status", "next_attempt_at");

-- Hand-written guards (not expressible in the Prisma schema).
-- A verdict is only ever CLEAN or INFECTED (a scanner failure is never stored as a verdict), and a finished job always has one.
ALTER TABLE "file_scan_jobs" ADD CONSTRAINT "file_scan_jobs_verdict_ck" CHECK ("verdict" IS NULL OR "verdict" IN ('CLEAN', 'INFECTED'));
ALTER TABLE "file_scan_jobs" ADD CONSTRAINT "file_scan_jobs_done_has_verdict_ck" CHECK (("status" = 'DONE') = ("verdict" IS NOT NULL));
ALTER TABLE "file_scan_jobs" ADD CONSTRAINT "file_scan_jobs_attempts_ck" CHECK ("attempts" >= 0);

