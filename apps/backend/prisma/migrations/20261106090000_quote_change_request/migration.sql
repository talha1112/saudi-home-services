-- A customer can ask a worker to change a quote (instead of choosing or rejecting it). The text lives on the quote until the worker edits it.
-- Rollback: ALTER TABLE "quotes" DROP COLUMN "change_request", DROP COLUMN "change_requested_at";
-- (a value added to an enum cannot be removed; an unused QUOTE_CHANGE_REQUESTED is harmless)
ALTER TYPE "BookingEventType" ADD VALUE 'QUOTE_CHANGE_REQUESTED';
ALTER TABLE "quotes" ADD COLUMN "change_request" VARCHAR(500),
ADD COLUMN "change_requested_at" TIMESTAMPTZ(3);
