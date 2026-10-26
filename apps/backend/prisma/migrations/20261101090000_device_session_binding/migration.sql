-- Bind push registrations to the session that made them (so ending the session can end its registrations).
--
-- A "session" is the family of refresh tokens descended from one sign-in (refresh_tokens.family_id); it is not a table, so session_id is a
-- plain UUID column and NOT a foreign key. Rotation keeps the family id, so a continuing session keeps its registrations.
--
-- What this does:
--   * adds a NULLABLE column (no default, no rewrite of the table, no data change) and an index on it.
--   * existing registrations keep session_id = NULL ("legacy"). They cannot be attributed to a session after the fact and no backfill is
--     attempted: the application's periodic sweep revokes a legacy registration when its owner has no live session left in that app, and
--     a legacy registration is replaced by a bound one the next time the app registers (every app start / token refresh).
--
-- Operational notes:
--   * ALTER TABLE ... ADD COLUMN (nullable, no default) is a catalog-only change in PostgreSQL; it takes a brief ACCESS EXCLUSIVE lock on
--     device_tokens. CREATE INDEX (not CONCURRENTLY, so it can run inside a migration) blocks writes to device_tokens while it builds;
--     the table is small (at most a few registrations per user).
--   * Nothing here is destructive. The old application version keeps working against the new column (it never reads or writes it).
--   * Rollback (no data is lost that cannot be recreated: the column only holds session ids):
--       DROP INDEX "device_tokens_session_id_idx";
--       ALTER TABLE "device_tokens" DROP COLUMN "session_id";
--     Deploy the previous application version first or at the same time; the new version needs the column.
ALTER TABLE "device_tokens" ADD COLUMN "session_id" UUID;

CREATE INDEX "device_tokens_session_id_idx" ON "device_tokens"("session_id");
