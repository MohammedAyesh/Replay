-- Academy WhatsApp messaging (WAHA). Additive only.
CREATE TABLE IF NOT EXISTS "academy_whatsapp_settings" (
  "academy_id" integer PRIMARY KEY CONSTRAINT "academy_whatsapp_settings_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "sender" text NOT NULL DEFAULT 'off',
  "locale" text NOT NULL DEFAULT 'ar',
  "daily_limit" integer NOT NULL DEFAULT 300,
  "automations" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "session_status" text,
  "connected_phone" text,
  "connected_name" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "academy_whatsapp_settings_sender_check" CHECK ("sender" IN ('own', 'replay', 'off')),
  CONSTRAINT "academy_whatsapp_settings_locale_check" CHECK ("locale" IN ('ar', 'en')),
  CONSTRAINT "academy_whatsapp_settings_daily_limit_check" CHECK ("daily_limit" BETWEEN 1 AND 5000)
);

CREATE TABLE IF NOT EXISTS "academy_whatsapp_broadcasts" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_whatsapp_broadcasts_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "body" text NOT NULL,
  "audience" jsonb NOT NULL,
  "recipient_count" integer NOT NULL DEFAULT 0,
  "created_by" integer CONSTRAINT "academy_whatsapp_broadcasts_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "scheduled_for" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "academy_whatsapp_broadcasts_academy_idx" ON "academy_whatsapp_broadcasts" ("academy_id", "created_at");

CREATE TABLE IF NOT EXISTS "academy_whatsapp_messages" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_whatsapp_messages_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "direction" text NOT NULL DEFAULT 'out',
  "kind" text NOT NULL,
  "broadcast_id" integer CONSTRAINT "academy_whatsapp_messages_broadcast_id_academy_whatsapp_broadca" REFERENCES "academy_whatsapp_broadcasts"("id") ON DELETE SET NULL,
  "sender_session" text,
  "phone" text NOT NULL,
  "recipient_name" text,
  "recipient_role" text,
  "player_id" integer CONSTRAINT "academy_whatsapp_messages_player_id_academy_players_id_fk" REFERENCES "academy_players"("id") ON DELETE SET NULL,
  "body" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "error" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "wa_message_id" text,
  "dedupe_key" text,
  "created_by" integer CONSTRAINT "academy_whatsapp_messages_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "scheduled_for" timestamptz NOT NULL DEFAULT now(),
  "claimed_at" timestamptz,
  "sent_at" timestamptz,
  "delivered_at" timestamptz,
  "read_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "academy_whatsapp_messages_direction_check" CHECK ("direction" IN ('out', 'in')),
  CONSTRAINT "academy_whatsapp_messages_status_check" CHECK ("status" IN ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped', 'received'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "academy_whatsapp_messages_dedupe_unique" ON "academy_whatsapp_messages" ("dedupe_key") WHERE "dedupe_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "academy_whatsapp_messages_queue_idx" ON "academy_whatsapp_messages" ("status", "scheduled_for");
CREATE INDEX IF NOT EXISTS "academy_whatsapp_messages_academy_idx" ON "academy_whatsapp_messages" ("academy_id", "created_at");
CREATE INDEX IF NOT EXISTS "academy_whatsapp_messages_wa_id_idx" ON "academy_whatsapp_messages" ("wa_message_id");
CREATE INDEX IF NOT EXISTS "academy_whatsapp_messages_broadcast_idx" ON "academy_whatsapp_messages" ("broadcast_id");

CREATE TABLE IF NOT EXISTS "academy_whatsapp_opt_outs" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_whatsapp_opt_outs_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "phone" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "academy_whatsapp_opt_outs_academy_phone_unique" UNIQUE ("academy_id", "phone")
);
