# Rule Change Notification System

## Overview

When HMRC rules are updated or categorization logic is fixed, existing transactions categorized under old rules may be incorrect. This system tracks which rule version was used for each transaction and flags those needing review.

## How It Works

### 1. Rule Version Tracking

Every transaction is tagged with the `rule_version` from `hmrc-rules.js` when categorized:

```javascript
// In server.js bulk categorization
rule_version: hmrcRules.metadata.version  // e.g., "1.1.0"
```

### 2. Flagging Transactions for Review

When rules change, run a SQL script to flag affected transactions:

```sql
UPDATE categorized_transactions
SET
  needs_review = true,
  review_reason = 'Explanation of what changed and why review is needed'
WHERE
  -- Conditions to identify affected transactions
  rule_version < '1.1.0' AND ...
```

### 3. User Notification

The app will show notifications for transactions marked `needs_review = true`:
- Dashboard badge/alert showing count of transactions needing review
- Filter in transaction list to show only flagged transactions
- Clear explanation in `review_reason` field

## When to Use This System

### Scenario 1: HMRC Rule Update
**Example**: Tax year changes, mileage rates updated

**Steps**:
1. Update `hmrc-rules.js` with new version number
2. Create SQL script to flag affected transactions
3. Test with a few sample transactions
4. Run migration in production
5. Users see notification to review affected transactions

### Scenario 2: Bug Fix in Categorization Logic
**Example**: Food transactions incorrectly marked 50% deductible (US rule)

**Steps**:
1. Fix the bug in server.js categorization logic
2. Update `hmrc-rules.js` version
3. Create migration SQL to flag transactions categorized with old logic
4. Document the change in this README

### Scenario 3: AI Categorization Improvement
**Example**: AI better understands business vs personal expenses

**Steps**:
- Usually don't flag for review (improvements, not corrections)
- Only flag if previous categorization was definitively wrong

## Migration Files

### Current Migrations

1. **add-rule-version-tracking.sql**
   - Adds `rule_version`, `needs_review`, `review_reason` columns
   - Run this FIRST before any other migrations

2. **flag-food-transactions-for-review.sql**
   - Flags food/meal transactions categorized before v1.1.0
   - Addresses: Food incorrectly categorized as 50% deductible

### Creating New Migrations

Template for flagging transactions:

```sql
-- Description of what changed
UPDATE categorized_transactions
SET
  needs_review = true,
  review_reason = 'Clear explanation for users (e.g., "Mileage rate changed from 45p to 50p - please review")'
WHERE
  -- Identify affected transactions
  (rule_version IS NULL OR rule_version < 'X.X.X')
  AND [conditions to identify specific transaction types]
  AND (needs_review IS NULL OR needs_review = false);  -- Don't re-flag

-- Show count of affected
SELECT COUNT(*) as affected_transactions FROM categorized_transactions
WHERE needs_review = true AND review_reason LIKE '%your change%';
```

## Version History

### v1.1.0 (2025-11-30)
**Changes**:
- Fixed UK food/meal rules: NOT deductible (was incorrectly 50%)
- Updated tax year to 2025/26

**Migration**: `flag-food-transactions-for-review.sql`

**Affected**: Food/meal transactions previously marked as tax deductible

### v1.0.0 (Initial)
- Base HMRC rules for 2024/25 tax year

## Best Practices

### When to Flag Transactions
✅ **DO** flag when:
- HMRC rules definitively changed
- Previous categorization was factually incorrect
- Tax implications significantly different

❌ **DON'T** flag when:
- Just improving AI suggestions
- Minor wording changes
- Categories reorganized but tax treatment same

### Writing Review Reasons
Good example:
> "HMRC food rules updated (v1.1.0): Regular meals and client entertainment are NOT tax deductible in UK. Previously categorized under incorrect 50% rule."

Bad example:
> "Rules changed, please review"

### Testing Migrations
Before running in production:

1. Test on a copy of the database
2. Check count of affected transactions
3. Manually verify a few flagged transactions are correct
4. Ensure unflagged transactions are not affected

## Future Enhancements

- [ ] API endpoint to get count of transactions needing review
- [ ] Dashboard notification UI
- [ ] One-click bulk recategorize for flagged transactions
- [ ] Email notifications when rules change
- [ ] Audit log of rule changes and affected users

## Technical Notes

### Database Schema

```sql
categorized_transactions (
  ...
  rule_version TEXT,              -- Version of HMRC rules used
  needs_review BOOLEAN,           -- Flag for user notification
  review_reason TEXT,             -- Explanation shown to user
  ...
)
```

### Indexing

Efficient query for transactions needing review:

```sql
CREATE INDEX idx_categorized_transactions_needs_review
ON categorized_transactions(user_id, needs_review)
WHERE needs_review = true;
```

## Maintenance

After each HMRC tax year (April 6th):
1. Update `hmrc-rules.js` with new tax year
2. Review all rules for changes
3. Create migration if needed
4. Update this README with version history
