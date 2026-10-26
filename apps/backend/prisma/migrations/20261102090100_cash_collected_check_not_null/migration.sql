-- Tighten the check added in 20261102090000_cash_payment_method.
--
-- "payment_method = 'CASH'" is NULL (not false) when payment_method is NULL, and a CHECK constraint passes on NULL, so the earlier constraint
-- let cash_collected_at be set on a booking whose method was never chosen. Require the method to be CASH explicitly.
--
-- Safe: no booking can have cash_collected_at set yet (the feature is new and only writes it for CASH bookings), so the re-added constraint
-- validates against existing rows at once.
-- Rollback: ALTER TABLE "bookings" DROP CONSTRAINT "bookings_cash_collected_only_for_cash";
--           ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cash_collected_only_for_cash" CHECK ("cash_collected_at" IS NULL OR "payment_method" = 'CASH');
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_cash_collected_only_for_cash";
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cash_collected_only_for_cash" CHECK ("cash_collected_at" IS NULL OR ("payment_method" IS NOT NULL AND "payment_method" = 'CASH'));
