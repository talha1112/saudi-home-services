-- The worker's "I've arrived" step. It is a timestamp, not a booking status: the state machine (CONFIRMED -> IN_PROGRESS -> COMPLETED) is unchanged.
-- Rollback: ALTER TABLE "bookings" DROP COLUMN "arrived_at";
ALTER TABLE "bookings" ADD COLUMN "arrived_at" TIMESTAMPTZ(3);
