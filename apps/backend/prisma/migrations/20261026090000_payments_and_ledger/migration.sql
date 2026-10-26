-- Payment attempts, verified-webhook inbox, refund requests and the append-only ledger.
-- Provider-neutral: no gateway is integrated. Money = integer halalas + explicit currency.

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('INITIATED', 'PROCESSING', 'SUCCEEDED', 'CAPTURED_UNAPPLIED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('PAYMENT_CAPTURED', 'PAYMENT_CAPTURED_UNAPPLIED', 'REFUND_COMPLETED', 'COMMISSION_ACCRUAL', 'WORKER_EARNING_ACCRUAL', 'WORKER_PAYOUT', 'CORRECTION');

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "provider_payment_id" VARCHAR(128),
    "status" "PaymentStatus" NOT NULL DEFAULT 'INITIATED',
    "open_slot" BOOLEAN,
    "amount_halalas" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "is_simulated" BOOLEAN NOT NULL DEFAULT false,
    "checkout_url" VARCHAR(1024),
    "checkout_expires_at" TIMESTAMPTZ(3),
    "captured_amount_halalas" INTEGER,
    "captured_currency" VARCHAR(3),
    "refund_reserved_halalas" INTEGER NOT NULL DEFAULT 0,
    "failure_code" VARCHAR(60),
    "failure_message" VARCHAR(255),
    "reconciliation_reason" VARCHAR(60),
    "last_provider_event_at" TIMESTAMPTZ(3),
    "processing_at" TIMESTAMPTZ(3),
    "settled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "account_scope" VARCHAR(80) NOT NULL DEFAULT 'default',
    "provider_event_id" VARCHAR(128) NOT NULL,
    "event_type" VARCHAR(40) NOT NULL,
    "provider_payment_id" VARCHAR(128),
    "payment_attempt_id" UUID,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "outcome" VARCHAR(60),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "amount_halalas" INTEGER,
    "currency" VARCHAR(3),
    "occurred_at" TIMESTAMPTZ(3),
    "is_simulated" BOOLEAN NOT NULL DEFAULT false,
    "payload_hash" CHAR(64),
    "processing_started_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(500),
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_refunds" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "amount_halalas" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "requested_by_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "provider" VARCHAR(40),
    "provider_refund_id" VARCHAR(128),
    "failure_code" VARCHAR(60),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "entry_type" "LedgerEntryType" NOT NULL,
    "amount_halalas" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "booking_id" UUID,
    "payment_id" UUID,
    "refund_id" UUID,
    "reverses_entry_id" UUID,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "source_type" VARCHAR(40) NOT NULL,
    "source_id" VARCHAR(64),
    "description" VARCHAR(255) NOT NULL,
    "is_simulated" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "posted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_attempts_status_created_at_idx" ON "payment_attempts"("status", "created_at");

-- CreateIndex
CREATE INDEX "payment_attempts_status_processing_at_idx" ON "payment_attempts"("status", "processing_at");

-- CreateIndex
CREATE INDEX "payment_attempts_booking_id_status_idx" ON "payment_attempts"("booking_id", "status");

-- CreateIndex
CREATE INDEX "payment_attempts_customer_id_created_at_idx" ON "payment_attempts"("customer_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_customer_id_idempotency_key_key" ON "payment_attempts"("customer_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_booking_id_attempt_number_key" ON "payment_attempts"("booking_id", "attempt_number");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_booking_id_open_slot_key" ON "payment_attempts"("booking_id", "open_slot");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_provider_provider_payment_id_key" ON "payment_attempts"("provider", "provider_payment_id");

-- CreateIndex
CREATE INDEX "payment_webhook_events_status_received_at_idx" ON "payment_webhook_events"("status", "received_at");

-- CreateIndex
CREATE INDEX "payment_webhook_events_payment_attempt_id_idx" ON "payment_webhook_events"("payment_attempt_id");

-- CreateIndex
CREATE INDEX "payment_webhook_events_provider_provider_payment_id_idx" ON "payment_webhook_events"("provider", "provider_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_events_provider_account_scope_provider_even_key" ON "payment_webhook_events"("provider", "account_scope", "provider_event_id");

-- CreateIndex
CREATE INDEX "payment_refunds_status_created_at_idx" ON "payment_refunds"("status", "created_at");

-- CreateIndex
CREATE INDEX "payment_refunds_payment_id_idx" ON "payment_refunds"("payment_id");

-- CreateIndex
CREATE INDEX "payment_refunds_booking_id_idx" ON "payment_refunds"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_refunds_requested_by_id_idempotency_key_key" ON "payment_refunds"("requested_by_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "payment_refunds_provider_provider_refund_id_key" ON "payment_refunds"("provider", "provider_refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_reverses_entry_id_key" ON "ledger_entries"("reverses_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_idempotency_key_key" ON "ledger_entries"("idempotency_key");

-- CreateIndex
CREATE INDEX "ledger_entries_booking_id_posted_at_idx" ON "ledger_entries"("booking_id", "posted_at");

-- CreateIndex
CREATE INDEX "ledger_entries_payment_id_idx" ON "ledger_entries"("payment_id");

-- CreateIndex
CREATE INDEX "ledger_entries_refund_id_idx" ON "ledger_entries"("refund_id");

-- CreateIndex
CREATE INDEX "ledger_entries_source_type_source_id_idx" ON "ledger_entries"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "ledger_entries_entry_type_posted_at_idx" ON "ledger_entries"("entry_type", "posted_at");

-- CreateIndex
CREATE INDEX "bookings_status_payment_due_at_idx" ON "bookings"("status", "payment_due_at");

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_payment_attempt_id_fkey" FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "payment_refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_reverses_entry_id_fkey" FOREIGN KEY ("reverses_entry_id") REFERENCES "ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Integrity rules Prisma cannot express. The application enforces the same rules; these make
-- PostgreSQL refuse inconsistent rows even if a bug or a manual edit tries.
-- ===========================================================================

-- ---- payment_attempts -----------------------------------------------------
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_amount_check"
  CHECK ("amount_halalas" > 0 AND "currency" ~ '^[A-Z]{3}$' AND "attempt_number" > 0);

-- open_slot is TRUE exactly while the attempt is open, so the UNIQUE (booking_id, open_slot) index
-- allows at most one open attempt per booking while keeping every historical attempt.
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_open_slot_check"
  CHECK ((COALESCE("open_slot", false)) = ("status"::text IN ('INITIATED', 'PROCESSING')));

ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_captured_check"
  CHECK (
    ("captured_amount_halalas" IS NULL) = ("captured_currency" IS NULL)
    AND ("captured_amount_halalas" IS NULL OR ("captured_amount_halalas" > 0 AND "captured_currency" ~ '^[A-Z]{3}$'))
    -- money-captured states must say how much
    AND ("status"::text NOT IN ('SUCCEEDED', 'CAPTURED_UNAPPLIED') OR "captured_amount_halalas" IS NOT NULL)
    -- SUCCEEDED means exactly the agreed amount in the agreed currency was captured and applied
    AND ("status"::text <> 'SUCCEEDED' OR ("captured_amount_halalas" = "amount_halalas" AND "captured_currency" = "currency"))
  );

-- Refund reservations can never exceed what was captured: the database refuses an over-refund
-- even if two requests race past the application check.
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_refund_reserved_check"
  CHECK ("refund_reserved_halalas" >= 0 AND "refund_reserved_halalas" <= COALESCE("captured_amount_halalas", 0));

-- ---- payment_webhook_events ----------------------------------------------
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_state_check"
  CHECK ("attempts" >= 0
         AND ("status"::text NOT IN ('PROCESSED', 'IGNORED') OR "processed_at" IS NOT NULL)
         AND ("amount_halalas" IS NULL OR "amount_halalas" > 0)
         AND ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'));

-- ---- payment_refunds -------------------------------------------------------
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_state_check"
  CHECK ("amount_halalas" > 0
         AND "currency" ~ '^[A-Z]{3}$'
         AND length(btrim("reason")) > 0
         AND ("status"::text NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED') OR "completed_at" IS NOT NULL));

-- ---- ledger_entries --------------------------------------------------------
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_amount_check"
  CHECK ("amount_halalas" <> 0
         AND "currency" ~ '^[A-Z]{3}$'
         AND (
           ("entry_type"::text IN ('PAYMENT_CAPTURED', 'PAYMENT_CAPTURED_UNAPPLIED', 'COMMISSION_ACCRUAL', 'WORKER_EARNING_ACCRUAL') AND "amount_halalas" > 0)
           OR ("entry_type"::text IN ('REFUND_COMPLETED', 'WORKER_PAYOUT') AND "amount_halalas" < 0)
           OR "entry_type"::text = 'CORRECTION'
         )
         AND ("entry_type"::text <> 'CORRECTION' OR "reverses_entry_id" IS NOT NULL)
         AND ("entry_type"::text <> 'REFUND_COMPLETED' OR "refund_id" IS NOT NULL)
         AND ("entry_type"::text NOT IN ('PAYMENT_CAPTURED', 'PAYMENT_CAPTURED_UNAPPLIED') OR "payment_id" IS NOT NULL));

-- ---------------------------------------------------------------------------
-- The ledger is APPEND-ONLY. Updates, deletes and TRUNCATE are refused by triggers, for every
-- database user (including the application). To correct a mistake post a CORRECTION entry.
--
-- Operational implications:
--   * Migrations must never UPDATE/DELETE ledger rows. A data fix is a new compensating entry.
--   * `prisma migrate reset` and DROP DATABASE still work (a reset drops the tables), but a plain
--     `DELETE FROM ledger_entries` or `TRUNCATE` will fail by design.
--   * Test suites that need to remove their own rows briefly disable the trigger (ALTER TABLE ...
--     DISABLE TRIGGER), which needs table ownership, inside a transaction, only on a *_test database.
--   * A superuser or the table owner can always disable the triggers: this guards against
--     application mistakes and casual edits, not against a malicious database administrator.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "ledger_entries_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: % is not allowed (post a CORRECTION entry instead)', TG_OP;
END;
$$;

CREATE TRIGGER "ledger_entries_no_update_delete"
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_entries_append_only"();

CREATE TRIGGER "ledger_entries_no_truncate"
  BEFORE TRUNCATE ON "ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "ledger_entries_append_only"();

-- ---------------------------------------------------------------------------
-- The money snapshot copied onto a booking when a quote is accepted is IMMUTABLE: once the
-- amounts are set they can never change, whatever pricing settings do later.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "bookings_money_snapshot_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."service_amount_halalas" IS NOT NULL AND (
       NEW."service_amount_halalas"    IS DISTINCT FROM OLD."service_amount_halalas"
    OR NEW."vat_amount_halalas"        IS DISTINCT FROM OLD."vat_amount_halalas"
    OR NEW."total_amount_halalas"      IS DISTINCT FROM OLD."total_amount_halalas"
    OR NEW."commission_amount_halalas" IS DISTINCT FROM OLD."commission_amount_halalas"
    OR NEW."worker_payout_halalas"     IS DISTINCT FROM OLD."worker_payout_halalas"
    OR NEW."vat_rate_bps"              IS DISTINCT FROM OLD."vat_rate_bps"
    OR NEW."commission_rate_bps"       IS DISTINCT FROM OLD."commission_rate_bps"
    OR NEW."currency"                  IS DISTINCT FROM OLD."currency"
  ) THEN
    RAISE EXCEPTION 'the agreed money snapshot of booking % is immutable', OLD."id";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "bookings_money_snapshot_immutable"
  BEFORE UPDATE ON "bookings"
  FOR EACH ROW EXECUTE FUNCTION "bookings_money_snapshot_immutable"();
