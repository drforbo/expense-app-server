-- Migration: Add export tracking to user_profiles
-- Run this in your Supabase SQL editor: https://app.supabase.com/project/YOUR_PROJECT/sql

-- Add last_export_date column to user_profiles table
ALTER TABLE user_profiles
ADD COLUMN IF NOT EXISTS last_export_date TIMESTAMP WITH TIME ZONE;

-- Comment to document the column
COMMENT ON COLUMN user_profiles.last_export_date IS 'Timestamp of the last CSV export by this user';

-- You can verify the change with:
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'user_profiles';
