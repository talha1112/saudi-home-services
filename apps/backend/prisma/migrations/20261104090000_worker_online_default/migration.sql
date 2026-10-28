-- Workers now switch themselves online and offline from the app, and an offline worker is not shown new requests. A newly approved worker
-- starts online (otherwise their feed is empty until they find the switch), and the workers approved so far are put online once.
-- What this does: changes a column default and updates the existing approved workers. No table or column is created or dropped.
ALTER TABLE "worker_profiles" ALTER COLUMN "is_online" SET DEFAULT true;
UPDATE "worker_profiles" SET "is_online" = true WHERE "verification_status" = 'APPROVED';
