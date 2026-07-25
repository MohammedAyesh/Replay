ALTER TABLE "academies" ADD COLUMN "live_access" boolean NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "academy_id" integer REFERENCES "academies"("id") ON DELETE SET NULL;
