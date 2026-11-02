-- Academy owners edit their own profile (Academy console → Profile): Arabic name, WhatsApp, email,
-- address, map location (overrides the field's for ads), social links. Additive only.
ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "name_ar" text;
ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "whatsapp_phone" text;
ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "email" text;
ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "address" text;
ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "latitude" real;
ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "longitude" real;
ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "instagram_url" text;
ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "facebook_url" text;
ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "website_url" text;
