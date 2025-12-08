-- Migration: Add received_from and reason fields to gifted_items table
-- Run this in your Supabase SQL editor: https://app.supabase.com/project/YOUR_PROJECT/sql

-- Add received_from column (who gave you the gift)
ALTER TABLE gifted_items
ADD COLUMN IF NOT EXISTS received_from TEXT;

-- Add reason column (why you received it - occasion, event, etc.)
ALTER TABLE gifted_items
ADD COLUMN IF NOT EXISTS reason TEXT;
