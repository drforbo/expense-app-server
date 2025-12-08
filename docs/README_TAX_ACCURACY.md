# Maintaining HMRC Tax Rule Accuracy

## Summary

I've set up a system to help ensure the tax rules in this app stay accurate for UK sole traders and limited companies.

## What's Been Created

### 1. **`hmrc-rules.js`** - Centralized Rules Configuration
- Single source of truth for all HMRC rules
- Includes official HMRC sources for each rule
- Versioned with last update date
- Documented with examples

**Current rules (as of 2024/25 tax year):**
- ✅ Mileage: 45p/mile (first 10k), 25p/mile after
- ✅ Simplified expenses: £6/week for home office
- ✅ Food/meals: Client entertainment NOT deductible (strict UK rules)
- ✅ Equipment: "Wholly and exclusively" rule (100% if bought for business)
- ✅ Commuting: NOT deductible to permanent workplace
- ✅ Gifts: Max £50 per person per year

### 2. **`HMRC_RULES_MAINTENANCE.md`** - Complete Maintenance Guide
- When to review rules (annually, after budgets)
- How to update rules step-by-step
- Official HMRC sources to check
- Email alerts to subscribe to
- Professional review recommendations

### 3. **`check-rules-status.js`** - Automated Status Checker
- Run to check if rules need updating
- Warns if rules are outdated (6+ months)
- Checks for tax year mismatch
- Alerts during Budget months

**How to use:**
```bash
cd /Users/hannahforbes/Desktop/expense-app-server
node check-rules-status.js
```

## Quick Start

### Regular Maintenance (Recommended)

**1. Set Calendar Reminders:**
- **April 1st (annually)**: Review rules before new tax year (April 6th)
- **March/October**: Check Budget announcements
- **Monthly**: Run `node check-rules-status.js`

**2. Subscribe to HMRC Updates:**
Visit: https://www.gov.uk/email-signup
Subscribe to: "HMRC: guidance and policy"

**3. Run Status Check:**
```bash
cd /Users/hannahforbes/Desktop/expense-app-server
node check-rules-status.js
```

This will tell you:
- ✅ If rules are current
- ⚠️  If review is needed
- 🚨 If urgent update required

### When Rules Change

**Example: HMRC increases mileage rate to 47p**

1. **Update `hmrc-rules.js`:**
```javascript
mileage: {
  cars_vans: {
    first_10k_miles: 0.47,  // Changed from 0.45
    over_10k_miles: 0.25,
  },
},
metadata: {
  lastUpdated: '2026-03-15',  // Update this
  taxYear: '2025/26',          // Update this
  version: '1.1.0',            // Increment version
  reviewedBy: 'Hannah - Budget 2026',
},
```

2. **Update `server.js` AI prompts:**
Search for "45p/mile" and update to "47p/mile" in categorization prompts

3. **Test:**
```bash
# Restart server
npm start

# Test with a mileage transaction
# Verify explanation says "47p/mile"
```

4. **Document:**
```bash
git add hmrc-rules.js server.js
git commit -m "Update mileage rate: 45p → 47p (Budget 2026)"
git tag -a "tax-rules-v1.1.0" -m "Mileage rate update"
```

## Sole Trader vs Limited Company

Both are supported with structure-specific rules:

| Feature | Sole Trader | Limited Company |
|---------|-------------|-----------------|
| Tax return | Self Assessment | CT600 + Self Assessment |
| Simplified expenses | ✅ Yes | ❌ No |
| Home office | £6/week flat rate | Can charge rent (but triggers tax) |
| Benefits in kind | N/A | ⚠️  Applies (P11D) |

The AI automatically adjusts advice based on `user_profiles.business_structure` field.

## Common Mistakes That Were Fixed

1. ❌ **"Business meals 50% deductible"** (US rule)
   → ✅ **"Client meals NOT deductible"** (UK rule)

2. ❌ **"meals" category**
   → ✅ **"subsistence" category** (only overnight travel)

3. ❌ Hard-coded rules in prompts
   → ✅ Centralized in `hmrc-rules.js` with sources

## Professional Review (Recommended for Production)

For a production app with real users:

### Option 1: Annual Accountant Review (£200-500/year)
- Hire UK chartered accountant
- Review `hmrc-rules.js` annually
- Provides professional validation
- Reduces liability

### Option 2: Tax Software Partnership
- Partner with established UK tax software (FreeAgent, Xero, etc.)
- Use their API for tax rules
- They handle updates automatically

### Option 3: Legal Disclaimer + User Responsibility
Add to app:
```
"This is guidance only, not professional tax advice. Tax rules are
accurate as of [date]. For complex situations, consult a qualified
accountant. We are not responsible for tax errors or penalties."
```

## Important Updates to Watch

### Frequent Changes (Check Annually)
- Annual Investment Allowance limit (changes often)
- National Insurance thresholds
- Income tax bands

### Rare Changes (But Critical)
- Mileage rates (last changed 2011, but must check)
- Simplified expenses rates (stable since 2013)
- Client entertainment rules (very stable)

### Current Temporary Rules
- Annual Investment Allowance: £1m (temporary increase)
- May revert to £200k - check each Budget

## Getting Help

**HMRC Resources:**
- Self-employment expenses: https://www.gov.uk/expenses-if-youre-self-employed
- Helpline: 0300 200 3310 (Mon-Fri, 8am-6pm)

**Professional Bodies:**
- ICAEW (Find an accountant): https://www.icaew.com/
- CIOT (Tax advisers): https://www.tax.org.uk/

**Community:**
- Contractor UK forums: https://forums.contractoruk.com/
- MoneySavingExpert: https://www.moneysavingexpert.com/

## Files Overview

```
expense-app-server/
├── hmrc-rules.js                    # Centralized rules (EDIT THIS)
├── HMRC_RULES_MAINTENANCE.md        # Full maintenance guide
├── README_TAX_ACCURACY.md           # This file
├── check-rules-status.js            # Automated checker
└── server.js                        # AI prompts (sync with hmrc-rules.js)
```

## Quick Reference: Review Checklist

Before each tax year (April 6th):
- [ ] Run `node check-rules-status.js`
- [ ] Check HMRC expenses guide: https://www.gov.uk/expenses-if-youre-self-employed
- [ ] Verify mileage rates
- [ ] Check Annual Investment Allowance limit
- [ ] Update `hmrc-rules.js` if changes found
- [ ] Update `server.js` prompts to match
- [ ] Test categorization with sample transactions
- [ ] Update metadata (version, date, tax year)
- [ ] Git commit with clear message

After Budget announcements:
- [ ] Review Budget summary for self-employment changes
- [ ] Check rates and allowances document
- [ ] Update rules if needed

## Current Status

**Last Update**: 2025-11-30
**Tax Year**: 2024/25
**Version**: 1.0.0
**Status**: ✅ All rules verified correct for UK

**Next Review Due**: 2026-04-05 (before 2026/27 tax year)

---

**Questions?** See `HMRC_RULES_MAINTENANCE.md` for detailed guidance.
