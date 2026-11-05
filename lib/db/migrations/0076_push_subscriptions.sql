-- Notifications for console users (new chat messages): their devices, and the server's VAPID keys. Additive only.
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL CONSTRAINT "push_subscriptions_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE CASCADE,
  "endpoint" text NOT NULL, "p256dh" text NOT NULL, "auth" text NOT NULL, "user_agent" text,
  "failures" integer DEFAULT 0 NOT NULL, "last_sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint"));
CREATE INDEX IF NOT EXISTS "push_subscriptions_user_idx" ON "push_subscriptions" ("user_id");
CREATE TABLE IF NOT EXISTS "web_push_keys" (
  "id" integer PRIMARY KEY DEFAULT 1, "public_key" text NOT NULL, "private_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "web_push_keys_single_row" CHECK ("id" = 1));
