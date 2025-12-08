-- Migration: Add rule version tracking to categorized_transactions
-- Run this in your Supabase SQL editor: https://app.supabase.com/project/YOUR_PROJECT/sql

-- Add rule_version column to track which HMRC rules were used for categorization
ALTER TABLE categorized_transactions
ADD COLUMN IF NOT EXISTS rule_version TEXT DEFAULT '1.1.0';

-- Add needs_review flag for transactions that may need recategorization
ALTER TABLE categorized_transactions
ADD COLUMN IF NOT EXISTS needs_review BOOLEAN DEFAULT false;

-- Add review_reason column to explain why review is needed
ALTER TABLE categorized_transactions
ADD COLUMN IF NOT EXISTS review_reason TEXT;

-- Create index for efficient querying of transactions needing review
CREATE INDEX IF NOT EXISTS idx_categorized_transactions_needs_review
ON categorized_transactions(user_id, needs_review)
WHERE needs_review = true;

-- Comment explaining the columns
COMMENT ON COLUMN categorized_transactions.rule_version IS 'Version of HMRC rules used for categorization (matches hmrc-rules.js version)';
COMMENT ON COLUMN categorized_transactions.needs_review IS 'Flag indicating transaction may need recategorization due to rule changes';
COMMENT ON COLUMN categorized_transactions.review_reason IS 'Explanation of why transaction needs review (e.g., "HMRC food rules updated - meals no longer 50% deductible")';
