-- The monthly value report: every People stage/kind change (written by a trigger), and shared report links. Additive only.
CREATE TABLE IF NOT EXISTS "academy_contact_stage_events" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_contact_stage_events_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "contact_id" integer NOT NULL CONSTRAINT "academy_contact_stage_events_contact_id_academy_contacts_id_fk" REFERENCES "academy_contacts"("id") ON DELETE CASCADE,
  "from_stage" text, "to_stage" text, "from_kind" text, "to_kind" text,
  "at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE INDEX IF NOT EXISTS "academy_contact_stage_events_academy_idx" ON "academy_contact_stage_events" ("academy_id", "at");
CREATE INDEX IF NOT EXISTS "academy_contact_stage_events_contact_idx" ON "academy_contact_stage_events" ("contact_id");
CREATE TABLE IF NOT EXISTS "academy_value_report_shares" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_value_report_shares_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "month" text NOT NULL, "token" text NOT NULL,
  "created_by" integer CONSTRAINT "academy_value_report_shares_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL, "revoked_at" timestamp with time zone,
  CONSTRAINT "academy_value_report_shares_token_unique" UNIQUE("token"),
  CONSTRAINT "academy_value_report_shares_month_check" CHECK ("month" ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT "academy_value_report_shares_token_check" CHECK ("token" ~ '^[0-9a-f]{32}$'));
CREATE OR REPLACE FUNCTION replay_contact_stage_event() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.kind = 'lead' OR NEW.stage IS NOT NULL THEN
      INSERT INTO academy_contact_stage_events (academy_id, contact_id, from_stage, to_stage, from_kind, to_kind) VALUES (NEW.academy_id, NEW.id, NULL, NEW.stage, NULL, NEW.kind);
    END IF;
  ELSIF NEW.stage IS DISTINCT FROM OLD.stage OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    INSERT INTO academy_contact_stage_events (academy_id, contact_id, from_stage, to_stage, from_kind, to_kind) VALUES (NEW.academy_id, NEW.id, OLD.stage, NEW.stage, OLD.kind, NEW.kind);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "academy_contacts_stage_events" ON "academy_contacts";
CREATE TRIGGER "academy_contacts_stage_events" AFTER INSERT OR UPDATE OF "stage", "kind" ON "academy_contacts" FOR EACH ROW EXECUTE FUNCTION replay_contact_stage_event();
