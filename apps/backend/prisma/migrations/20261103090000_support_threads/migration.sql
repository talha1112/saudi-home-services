-- Support conversations between a customer / worker and the administrators.
--
-- What this does: creates one enum and two NEW tables (support_threads: one row per user; support_messages: the messages). Nothing here
-- touches an existing table or any existing data. The CHECK constraints at the end are hand-written (Prisma cannot express them).
--
-- Rollback (only support conversations are lost): DROP TABLE "support_messages"; DROP TABLE "support_threads"; DROP TYPE "SupportThreadStatus";

-- CreateEnum
CREATE TYPE "SupportThreadStatus" AS ENUM ('OPEN', 'ANSWERED', 'RESOLVED');

-- CreateTable
CREATE TABLE "support_threads" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "SupportThreadStatus" NOT NULL DEFAULT 'OPEN',
    "last_sender_role" "Role" NOT NULL,
    "last_message_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "support_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_messages" (
    "id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "sender_user_id" UUID NOT NULL,
    "sender_role" "Role" NOT NULL,
    "client_message_id" VARCHAR(64) NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_threads_user_id_key" ON "support_threads"("user_id");

-- CreateIndex
CREATE INDEX "support_threads_status_last_message_at_idx" ON "support_threads"("status", "last_message_at");

-- CreateIndex
CREATE INDEX "support_messages_sender_user_id_idx" ON "support_messages"("sender_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "support_messages_thread_id_seq_key" ON "support_messages"("thread_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "support_messages_thread_id_sender_user_id_client_message_id_key" ON "support_messages"("thread_id", "sender_user_id", "client_message_id");

-- AddForeignKey
ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "support_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written guards: a message is 1..2000 characters, numbered from 1, and its sender role is one of the three roles.
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_body_check" CHECK (char_length("body") BETWEEN 1 AND 2000);
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_seq_check" CHECK ("seq" >= 1);
