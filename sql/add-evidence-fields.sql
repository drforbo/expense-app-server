-- Migration: Add evidence tracking fields to categorized_transactions
-- Run this in your Supabase SQL editor: https://app.supabase.com/project/YOUR_PROJECT/sql

-- Add evidence fields
ALTER TABLE categorized_transactions
ADD COLUMN IF NOT EXISTS receipt_image_url TEXT,
ADD COLUMN IF NOT EXISTS business_use_explanation TEXT,
ADD COLUMN IF NOT EXISTS content_link TEXT,
ADD COLUMN IF NOT EXISTS qualified BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS qualified_at TIMESTAMP;

-- Create index for filtering qualified transactions
CREATE INDEX IF NOT EXISTS idx_categorized_transactions_qualified
ON categorized_transactions(user_id, qualified)
WHERE qualified = true;

-- Create index for unqualified transactions
CREATE INDEX IF NOT EXISTS idx_categorized_transactions_unqualified
ON categorized_transactions(user_id, qualified)
WHERE qualified = false OR qualified IS NULL;
