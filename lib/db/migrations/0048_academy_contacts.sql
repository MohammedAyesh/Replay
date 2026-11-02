-- Academy people (CRM) and their links to players. Additive only.
CREATE TABLE IF NOT EXISTS "academy_contacts" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_contacts_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "phone" text NOT NULL,
  "name" text,
  "kind" text NOT NULL DEFAULT 'unknown',
  "stage" text,
  "source" text NOT NULL DEFAULT 'manual',
  "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "notes" text,
  "last_read_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "academy_contacts_academy_phone_unique" UNIQUE ("academy_id", "phone"),
  CONSTRAINT "academy_contacts_kind_check" CHECK ("kind" IN ('unknown', 'lead', 'parent', 'player', 'coach', 'staff', 'other')),
  CONSTRAINT "academy_contacts_stage_check" CHECK ("stage" IS NULL OR "stage" IN ('new', 'contacted', 'trial', 'joined', 'lost'))
);

CREATE TABLE IF NOT EXISTS "academy_contact_players" (
  "id" serial PRIMARY KEY,
  "contact_id" integer NOT NULL CONSTRAINT "academy_contact_players_contact_id_academy_contacts_id_fk" REFERENCES "academy_contacts"("id") ON DELETE CASCADE,
  "player_id" integer NOT NULL CONSTRAINT "academy_contact_players_player_id_academy_players_id_fk" REFERENCES "academy_players"("id") ON DELETE CASCADE,
  "relationship" text NOT NULL DEFAULT 'guardian',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "academy_contact_players_contact_player_unique" UNIQUE ("contact_id", "player_id"),
  CONSTRAINT "academy_contact_players_relationship_check" CHECK ("relationship" IN ('father', 'mother', 'guardian', 'sibling', 'relative', 'self', 'other'))
);
CREATE INDEX IF NOT EXISTS "academy_contact_players_player_idx" ON "academy_contact_players" ("player_id");
