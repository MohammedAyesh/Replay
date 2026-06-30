-- Add is_admin to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

-- Ads campaigns
CREATE TABLE IF NOT EXISTS ads (
  id serial PRIMARY KEY,
  title text NOT NULL,
  creative_url text NOT NULL,
  click_url text NOT NULL,
  duration_seconds integer NOT NULL DEFAULT 15,
  target_type text NOT NULL DEFAULT 'all',
  target_field_id integer REFERENCES fields(id),
  starts_at timestamptz,
  ends_at timestamptz,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Ad impressions
CREATE TABLE IF NOT EXISTS ad_impressions (
  id serial PRIMARY KEY,
  ad_id integer NOT NULL REFERENCES ads(id),
  user_id integer REFERENCES users(id),
  clip_id integer REFERENCES clips(id),
  shown_at timestamptz NOT NULL DEFAULT now(),
  completed boolean NOT NULL DEFAULT false,
  skipped_at_second integer
);

-- Ad clicks
CREATE TABLE IF NOT EXISTS ad_clicks (
  id serial PRIMARY KEY,
  ad_id integer NOT NULL REFERENCES ads(id),
  user_id integer REFERENCES users(id),
  clicked_at timestamptz NOT NULL DEFAULT now()
);
