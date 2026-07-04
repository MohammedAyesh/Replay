ALTER TABLE "clips" ADD COLUMN "start_time" numeric(10, 6) NOT NULL DEFAULT '0';
ALTER TABLE "clips" ADD COLUMN "end_time" numeric(10, 6) NOT NULL DEFAULT '1';
ALTER TABLE "clips" ADD COLUMN "crop_path" jsonb NOT NULL DEFAULT '[]'::jsonb;
