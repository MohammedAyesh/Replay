-- Field console booking rules: accepted payments, deposits for new and no-show customers,
-- late-cancel / no-show / change fees, refunds. Additive only.

ALTER TABLE "venue_settings" ADD COLUMN IF NOT EXISTS "accept_cliq" boolean DEFAULT true NOT NULL;
ALTER TABLE "venue_settings" ADD COLUMN IF NOT EXISTS "deposit_percent" integer DEFAULT 0 NOT NULL;
ALTER TABLE "venue_settings" ADD COLUMN IF NOT EXISTS "new_customer_policy" text DEFAULT 'same' NOT NULL;
ALTER TABLE "venue_settings" ADD COLUMN IF NOT EXISTS "no_show_policy" text DEFAULT 'same' NOT NULL;
ALTER TABLE "venue_settings" ADD COLUMN IF NOT EXISTS "late_cancel_mode" text DEFAULT 'refuse' NOT NULL;
ALTER TABLE "venue_settings" ADD COLUMN IF NOT EXISTS "late_cancel_value" integer DEFAULT 0 NOT NULL;
ALTER TABLE "venue_settings" ADD COLUMN IF NOT EXISTS "no_show_fee_mode" text DEFAULT 'deposit' NOT NULL;
ALTER TABLE "venue_settings" ADD COLUMN IF NOT EXISTS "no_show_fee_value" integer DEFAULT 0 NOT NULL;
ALTER TABLE "venue_settings" ADD COLUMN IF NOT EXISTS "allow_changes" boolean DEFAULT true NOT NULL;
ALTER TABLE "venue_settings" ADD COLUMN IF NOT EXISTS "change_hours" integer DEFAULT 6 NOT NULL;
ALTER TABLE "venue_settings" ADD COLUMN IF NOT EXISTS "change_fee_fils" integer DEFAULT 0 NOT NULL;
ALTER TABLE "venue_settings" ADD COLUMN IF NOT EXISTS "max_changes" integer DEFAULT 2 NOT NULL;
ALTER TABLE "venue_bookings" ADD COLUMN IF NOT EXISTS "fee_fils" integer DEFAULT 0 NOT NULL;
ALTER TABLE "venue_bookings" ADD COLUMN IF NOT EXISTS "fee_reason" text;
ALTER TABLE "venue_bookings" ADD COLUMN IF NOT EXISTS "refund_due_fils" integer DEFAULT 0 NOT NULL;
ALTER TABLE "venue_bookings" ADD COLUMN IF NOT EXISTS "refunded_fils" integer DEFAULT 0 NOT NULL;
ALTER TABLE "venue_bookings" ADD COLUMN IF NOT EXISTS "change_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "venue_bookings" ADD COLUMN IF NOT EXISTS "policy" jsonb;
ALTER TABLE "venue_bookings" ADD COLUMN IF NOT EXISTS "cancelled_by" text;
