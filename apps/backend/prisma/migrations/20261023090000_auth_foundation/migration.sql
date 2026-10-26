-- Admin accounts have no phone number.
ALTER TABLE "users" ALTER COLUMN "phone" DROP NOT NULL;
ALTER TABLE "users" ADD CONSTRAINT "users_phone_or_email_check" CHECK ("phone" IS NOT NULL OR "email" IS NOT NULL);

-- Forced password change after bootstrap/reset.
ALTER TABLE "users" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "password_changed_at" TIMESTAMPTZ(3);

-- Each session acts as one role. The temporary default only back-fills any existing rows.
ALTER TABLE "refresh_tokens" ADD COLUMN "session_role" "Role" NOT NULL DEFAULT 'CUSTOMER';
ALTER TABLE "refresh_tokens" ALTER COLUMN "session_role" DROP DEFAULT;
