-- Phase 7: booking chat, chat receipts and the transactional realtime outbox.
-- Generated tables below; the CHECK constraints, triggers and partial index at the end are hand-written
-- (Prisma cannot express them). Nothing here touches existing tables or data.

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "sender_user_id" UUID NOT NULL,
    "sender_role" "Role" NOT NULL,
    "client_message_id" VARCHAR(64) NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_participant_states" (
    "booking_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "delivered_up_to_seq" INTEGER NOT NULL DEFAULT 0,
    "read_up_to_seq" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_participant_states_pkey" PRIMARY KEY ("booking_id","user_id")
);

-- CreateTable
CREATE TABLE "realtime_outbox_events" (
    "id" UUID NOT NULL,
    "booking_event_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMPTZ(3),
    "dead_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(120),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realtime_outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_messages_sender_user_id_idx" ON "chat_messages"("sender_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_messages_booking_id_seq_key" ON "chat_messages"("booking_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "chat_messages_booking_id_sender_user_id_client_message_id_key" ON "chat_messages"("booking_id", "sender_user_id", "client_message_id");

-- CreateIndex
CREATE INDEX "chat_participant_states_user_id_idx" ON "chat_participant_states"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "realtime_outbox_events_booking_event_id_key" ON "realtime_outbox_events"("booking_event_id");

-- CreateIndex
CREATE INDEX "realtime_outbox_events_booking_id_idx" ON "realtime_outbox_events"("booking_id");

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_participant_states" ADD CONSTRAINT "chat_participant_states_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_participant_states" ADD CONSTRAINT "chat_participant_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "realtime_outbox_events" ADD CONSTRAINT "realtime_outbox_events_booking_event_id_fkey" FOREIGN KEY ("booking_event_id") REFERENCES "booking_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "realtime_outbox_events" ADD CONSTRAINT "realtime_outbox_events_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Hand-written constraints
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "chat_messages"
  ADD CONSTRAINT "chat_messages_seq_positive" CHECK ("seq" > 0),
  ADD CONSTRAINT "chat_messages_sender_role_ck" CHECK ("sender_role" IN ('CUSTOMER', 'WORKER')),
  ADD CONSTRAINT "chat_messages_body_not_blank" CHECK (length(btrim("body")) > 0),
  ADD CONSTRAINT "chat_messages_client_id_not_blank" CHECK (length(btrim("client_message_id")) > 0);

ALTER TABLE "chat_participant_states"
  ADD CONSTRAINT "chat_states_cursors_ordered" CHECK ("read_up_to_seq" >= 0 AND "delivered_up_to_seq" >= "read_up_to_seq");

ALTER TABLE "realtime_outbox_events"
  ADD CONSTRAINT "outbox_attempts_nonneg" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "outbox_not_both_done_and_dead" CHECK ("dispatched_at" IS NULL OR "dead_at" IS NULL);

-- The dispatcher only ever looks at rows that still need work.
CREATE INDEX "realtime_outbox_pending_idx" ON "realtime_outbox_events" ("next_attempt_at") WHERE "dispatched_at" IS NULL AND "dead_at" IS NULL;
-- Retention sweeps look at finished rows by age.
CREATE INDEX "realtime_outbox_done_idx" ON "realtime_outbox_events" ("created_at") WHERE "dispatched_at" IS NOT NULL OR "dead_at" IS NOT NULL;

-- Messages are history: they can be inserted, never edited.
CREATE FUNCTION chat_messages_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'chat_messages are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chat_messages_no_update
  BEFORE UPDATE ON "chat_messages"
  FOR EACH ROW EXECUTE FUNCTION chat_messages_immutable();

-- Defence in depth: even a buggy service cannot store a message from someone who is not a participant,
-- or with a role that does not match their side of the booking.
CREATE FUNCTION chat_messages_check_participant() RETURNS trigger AS $$
DECLARE
  b_customer uuid;
  b_worker_user uuid;
BEGIN
  SELECT bk."customer_id", wp."user_id" INTO b_customer, b_worker_user
    FROM "bookings" bk LEFT JOIN "worker_profiles" wp ON wp."id" = bk."worker_profile_id"
    WHERE bk."id" = NEW."booking_id";
  IF NEW."sender_role" = 'CUSTOMER' AND NEW."sender_user_id" IS NOT DISTINCT FROM b_customer THEN
    RETURN NEW;
  END IF;
  IF NEW."sender_role" = 'WORKER' AND b_worker_user IS NOT NULL AND NEW."sender_user_id" = b_worker_user THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'chat sender is not a participant of this booking';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chat_messages_participant_check
  BEFORE INSERT ON "chat_messages"
  FOR EACH ROW EXECUTE FUNCTION chat_messages_check_participant();
