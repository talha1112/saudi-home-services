-- Audit-log integrity (no table or column changes).
--
-- audit_logs becomes append-only at the database level, like ledger_entries:
--   * DELETE and TRUNCATE are refused.
--   * UPDATE is refused, with ONE exception: clearing "actor_user_id" (non-null -> NULL) while every other column stays
--     identical. That is exactly what the foreign key (ON DELETE SET NULL) does when a user row is removed, so deleting a user
--     keeps working and the history stays, but an entry can never be edited, re-attributed or have its content rewritten.
--
-- Operational notes:
--   * Adds two triggers and one function; takes a brief lock on audit_logs while they are created. No rows are read or changed.
--   * Retention/archiving of old entries is deliberately not possible from the application. If a retention policy is approved,
--     it needs a reviewed, separately authorised maintenance procedure (for example a partition detach by the table owner).
--   * Test suites that remove their own rows briefly disable the delete trigger (ALTER TABLE ... DISABLE TRIGGER) inside a
--     transaction, only on a *_test database. The table owner or a superuser can always disable the triggers: this guards
--     against application mistakes, injected SQL through the application role and casual edits, not against a malicious
--     database administrator. For that, run the application as a role that does NOT own the table, and export entries
--     off-site.
--   * Rollback: DROP TRIGGER audit_logs_append_only ON audit_logs; DROP TRIGGER audit_logs_no_truncate ON audit_logs;
--     DROP FUNCTION audit_logs_append_only();
CREATE FUNCTION "audit_logs_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."actor_user_id" IS NOT NULL
     AND NEW."actor_user_id" IS NULL
     AND NEW."id" = OLD."id"
     AND NEW."action" = OLD."action"
     AND NEW."entity_type" = OLD."entity_type"
     AND NEW."entity_id" IS NOT DISTINCT FROM OLD."entity_id"
     AND NEW."metadata" IS NOT DISTINCT FROM OLD."metadata"
     AND NEW."request_id" IS NOT DISTINCT FROM OLD."request_id"
     AND NEW."ip_address" IS NOT DISTINCT FROM OLD."ip_address"
     AND NEW."user_agent" IS NOT DISTINCT FROM OLD."user_agent"
     AND NEW."created_at" = OLD."created_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only: % is not allowed', TG_OP;
END;
$$;

CREATE TRIGGER "audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "audit_logs_append_only"();

CREATE TRIGGER "audit_logs_no_truncate"
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_logs_append_only"();
