-- Migration: Add gifted_items table for tracking gifts as income
-- Run this in your Supabase SQL editor: https://app.supabase.com/project/YOUR_PROJECT/sql

-- Create gifted_items table
CREATE TABLE IF NOT EXISTS gifted_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  rrp DECIMAL(10, 2) NOT NULL, -- Recommended Retail Price
  photo_url TEXT, -- URL to photo in Supabase storage
  notes TEXT,
  received_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add index on user_id for faster queries
CREATE INDEX IF NOT EXISTS idx_gifted_items_user_id ON gifted_items(user_id);

-- Add index on received_date for date range queries
CREATE INDEX IF NOT EXISTS idx_gifted_items_received_date ON gifted_items(received_date);

-- Enable Row Level Security
ALTER TABLE gifted_items ENABLE ROW LEVEL SECURITY;

-- Create policy: Users can only see their own gifted items
CREATE POLICY "Users can view their own gifted items"
  ON gifted_items FOR SELECT
  USING (auth.uid() = user_id);

-- Create policy: Users can insert their own gifted items
CREATE POLICY "Users can insert their own gifted items"
  ON gifted_items FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Create policy: Users can update their own gifted items
CREATE POLICY "Users can update their own gifted items"
  ON gifted_items FOR UPDATE
  USING (auth.uid() = user_id);

-- Create policy: Users can delete their own gifted items
CREATE POLICY "Users can delete their own gifted items"
  ON gifted_items FOR DELETE
  USING (auth.uid() = user_id);

-- Create storage bucket for gifted item photos (if it doesn't exist)
INSERT INTO storage.buckets (id, name, public)
VALUES ('gifted-items', 'gifted-items', true)
ON CONFLICT (id) DO NOTHING;

-- Create storage policy: Users can upload their own photos
CREATE POLICY "Users can upload their own gifted item photos"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'gifted-items' AND
    auth.uid()::text = (storage.foldername(name))[1]
  );

-- Create storage policy: Anyone can view gifted item photos
CREATE POLICY "Anyone can view gifted item photos"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'gifted-items');

-- Create storage policy: Users can update their own photos
CREATE POLICY "Users can update their own gifted item photos"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'gifted-items' AND
    auth.uid()::text = (storage.foldername(name))[1]
  );

-- Create storage policy: Users can delete their own photos
CREATE POLICY "Users can delete their own gifted item photos"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'gifted-items' AND
    auth.uid()::text = (storage.foldername(name))[1]
  );

-- Verify the table was created
-- SELECT * FROM gifted_items LIMIT 1;
