-- Cash on delivery: the customer may choose to pay the worker in person instead of online.
--
-- What this does:
--   * adds two NULLABLE columns to bookings (no default, no rewrite, no data change):
--       payment_method     'ONLINE' | 'CASH' | NULL  (NULL = not chosen yet, or confirmed before this column existed)
--       cash_collected_at  when the worker confirmed they received the cash (CASH only)
--   * adds two CHECK constraints so the database itself refuses a value the application never writes.
--
-- Operational notes:
--   * ADD COLUMN nullable without default is a catalog-only change; the CHECK constraints are validated against existing rows, all of which
--     have NULL in both columns, so they pass at once. Nothing here is destructive; the previous application version never reads or writes
--     the new columns and keeps working.
--   * Rollback (the columns only hold what this feature wrote):
--       ALTER TABLE "bookings" DROP CONSTRAINT "bookings_cash_collected_only_for_cash";
--       ALTER TABLE "bookings" DROP CONSTRAINT "bookings_payment_method_check";
--       ALTER TABLE "bookings" DROP COLUMN "cash_collected_at", DROP COLUMN "payment_method";
ALTER TABLE "bookings" ADD COLUMN "payment_method" VARCHAR(10);
ALTER TABLE "bookings" ADD COLUMN "cash_collected_at" TIMESTAMPTZ(3);

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_payment_method_check" CHECK ("payment_method" IS NULL OR "payment_method" IN ('ONLINE', 'CASH'));
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cash_collected_only_for_cash" CHECK ("cash_collected_at" IS NULL OR "payment_method" = 'CASH');
