-- Migration: add preferred_locale column to users table
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS).

ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_locale text;
