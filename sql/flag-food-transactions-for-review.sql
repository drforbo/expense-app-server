-- One-time script to flag food/meal transactions categorized with old rules
-- Run this AFTER running add-rule-version-tracking.sql
-- This addresses the specific issue: food/meals were incorrectly categorized as 50% deductible (US rule)

-- Flag transactions that are food-related and were categorized before the fix
UPDATE categorized_transactions
SET
  needs_review = true,
  review_reason = 'HMRC food rules updated (v1.1.0): Regular meals and client entertainment are NOT tax deductible in UK. Previously categorized under incorrect 50% rule.'
WHERE
  -- Food-related merchants (common patterns)
  (
    LOWER(merchant_name) LIKE '%pret%' OR
    LOWER(merchant_name) LIKE '%starbucks%' OR
    LOWER(merchant_name) LIKE '%costa%' OR
    LOWER(merchant_name) LIKE '%cafe%' OR
    LOWER(merchant_name) LIKE '%restaurant%' OR
    LOWER(merchant_name) LIKE '%leon%' OR
    LOWER(merchant_name) LIKE '%mcdonald%' OR
    LOWER(merchant_name) LIKE '%kfc%' OR
    LOWER(merchant_name) LIKE '%nando%' OR
    LOWER(merchant_name) LIKE '%pizza%' OR
    LOWER(merchant_name) LIKE '%greggs%' OR
    LOWER(merchant_name) LIKE '%subway%' OR
    LOWER(category_name) LIKE '%food%' OR
    LOWER(category_name) LIKE '%meal%' OR
    LOWER(category_name) LIKE '%restaurant%' OR
    LOWER(category_name) LIKE '%subsistence%'
  )
  -- Only flag if it was marked as tax deductible (which is incorrect for most food)
  AND tax_deductible = true
  -- Only flag transactions categorized before the fix (v1.1.0)
  AND (rule_version IS NULL OR rule_version < '1.1.0')
  -- Don't re-flag transactions already under review
  AND (needs_review IS NULL OR needs_review = false);

-- Show count of affected transactions
SELECT COUNT(*) as affected_transactions FROM categorized_transactions
WHERE needs_review = true AND review_reason LIKE '%HMRC food rules%';
