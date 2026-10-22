CREATE TABLE IF NOT EXISTS "user_clip_audit_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "clip_id" integer NOT NULL,
  "clip_owner_id" integer,
  "actor_user_id" integer,
  "actor_role" text NOT NULL,
  "action" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_clip_audit_events_clip_owner_id_users_id_fk"
    FOREIGN KEY ("clip_owner_id") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "user_clip_audit_events_actor_user_id_users_id_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "user_clip_audit_events_clip_created_idx"
  ON "user_clip_audit_events" USING btree ("clip_id", "created_at");
CREATE INDEX IF NOT EXISTS "user_clip_audit_events_actor_created_idx"
  ON "user_clip_audit_events" USING btree ("actor_user_id", "created_at");
