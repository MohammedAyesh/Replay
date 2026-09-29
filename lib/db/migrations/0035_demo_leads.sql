CREATE TABLE IF NOT EXISTS "demo_leads" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "place" text NOT NULL,
  "phone" text NOT NULL,
  "persona" text NOT NULL,
  "locale" text DEFAULT 'ar' NOT NULL,
  "handled" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "demo_leads_created_idx"
  ON "demo_leads" USING btree ("created_at");
