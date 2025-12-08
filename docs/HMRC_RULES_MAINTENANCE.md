# HMRC Rules Maintenance Guide

## Why This Matters

Incorrect tax advice can lead to:
- Users paying too much tax (claiming too little)
- Users facing HMRC penalties (claiming too much)
- Legal liability for the app

## Maintenance Strategy

### 1. **Regular Review Schedule**

#### Annual Review (REQUIRED)
- **When**: Before April 6th (start of UK tax year)
- **What**: Review all rules in `hmrc-rules.js`
- **Check**:
  - [ ] Mileage rates (usually announced in Budget)
  - [ ] Simplified expenses rates
  - [ ] Annual Investment Allowance limit
  - [ ] National Insurance thresholds
  - [ ] Any new HMRC guidance

#### Budget Reviews (REQUIRED)
- **When**: After Spring Budget (usually March) and Autumn Budget (if any)
- **What**: Check HMRC announcements for changes
- **Sources**:
  - https://www.gov.uk/government/topical-events/budget-2024
  - https://www.gov.uk/government/organisations/hm-revenue-customs/latest

### 2. **How to Update Rules**

#### Step 1: Check Official Sources
1. **HMRC Guidance**: https://www.gov.uk/expenses-if-youre-self-employed
2. **Mileage Rates**: https://www.gov.uk/government/publications/rates-and-allowances-travel-mileage-and-fuel-allowances
3. **Simplified Expenses**: https://www.gov.uk/simpler-income-tax-simplified-expenses
4. **HMRC Newsletters**: Subscribe at https://www.gov.uk/government/email-signup/new?email_signup%5Bfeed%5D=https://www.gov.uk/government/organisations/hm-revenue-customs.atom

#### Step 2: Update Configuration
1. Open `hmrc-rules.js`
2. Update the relevant values
3. Update `metadata.lastUpdated` and `metadata.taxYear`
4. Update `metadata.reviewedBy` with your name/date
5. Add comments explaining what changed and why

#### Step 3: Update AI Prompts
1. Open `server.js`
2. Find the categorization prompts (search for "HMRC TAX RULES")
3. Update the rules text to match `hmrc-rules.js`
4. Ensure examples reflect the new rules

#### Step 4: Test Changes
1. Restart the server
2. Test categorization with affected transaction types
3. Verify explanations are accurate
4. Check CSV export includes correct categories

### 3. **Common Rule Changes to Watch For**

| Rule | Frequency | Where to Check |
|------|-----------|----------------|
| Mileage rates | Rarely (5+ years) | Budget announcements |
| Simplified expenses | Rarely | HMRC guidance updates |
| Annual Investment Allowance | Often (changes frequently) | Budget announcements |
| NI thresholds | Annually | Budget announcements |
| Client entertainment | Very rare | HMRC policy changes |

### 4. **Professional Review (RECOMMENDED)**

For production use, consider:

1. **Annual Tax Professional Review**
   - Hire a UK chartered accountant to review `hmrc-rules.js`
   - Cost: £200-500/year
   - Benefit: Professional validation, reduces liability

2. **Legal Disclaimer**
   - Add to app: "This is guidance only, not professional tax advice"
   - Recommend users consult accountant for complex situations
   - Document that rules are "as of [date]"

3. **User Feedback Loop**
   - Add "Report incorrect tax advice" button
   - Monitor user reports for potential rule errors
   - Track common issues

### 5. **Monitoring for Changes**

#### Set Up Alerts
1. **HMRC Email Alerts**
   - Go to: https://www.gov.uk/email-signup
   - Subscribe to: "HMRC: guidance and policy"
   - Topics: Self Assessment, Self-employed

2. **Google Alerts**
   - "HMRC mileage rates change"
   - "HMRC simplified expenses change"
   - "UK Budget tax changes"

3. **Calendar Reminders**
   - March: Check Spring Budget
   - April: Annual review before tax year
   - October: Check for Autumn Budget

### 6. **Version Control**

Track all changes to tax rules:

```bash
# When updating rules
git add hmrc-rules.js server.js
git commit -m "Update HMRC rules: [what changed] - Tax year 2025/26"
git tag -a "tax-rules-v2.0.0" -m "Updated for 2025/26 tax year"
```

Keep a changelog:
```
## [2.0.0] - 2025-04-06
### Changed
- Mileage rate for first 10k miles: 45p -> 47p
- Annual Investment Allowance: £1m -> £500k

## [1.1.0] - 2025-03-15
### Fixed
- Corrected meal expenses (removed incorrect 50% rule)
```

### 7. **Emergency Updates**

If HMRC releases urgent changes mid-year:

1. **Assess Impact**: Does this affect existing categorizations?
2. **Update Rules**: `hmrc-rules.js` immediately
3. **Update Prompts**: `server.js` categorization logic
4. **User Communication**:
   - Add in-app notice if rules changed
   - Email users if previously categorized transactions affected
   - Suggest re-categorization if needed
5. **Test Thoroughly**: Don't rush - incorrect tax advice is worse than slow updates

### 8. **Differences Between Sole Trader and Limited Company**

Current implementation covers both, but watch for:

| Area | Sole Trader | Limited Company |
|------|-------------|-----------------|
| Simplified expenses | ✅ Can use | ❌ Cannot use |
| Home office | £6/week flat rate | Can charge rent (triggers tax) |
| Salary | ❌ Cannot pay self | ✅ Can pay salary + dividends |
| Benefits in kind | N/A | ⚠️ P11D taxes apply |
| IR35 | N/A | ⚠️ Applies to contractors |

### 9. **Testing Checklist**

After any rule update:

- [ ] Test food/meal categorization (often confused)
- [ ] Test equipment purchase (capital allowance)
- [ ] Test phone/internet (ongoing vs one-time)
- [ ] Test mileage/travel expenses
- [ ] Test home office expenses
- [ ] Test client gifts
- [ ] Verify CSV export categories match
- [ ] Check AI explanations cite correct rules

### 10. **When in Doubt**

**DO**:
- Be conservative (better to under-claim than over-claim)
- Cite HMRC sources in explanations
- Recommend professional advice for complex cases
- Document uncertainty in the explanation

**DON'T**:
- Guess or assume rules from other countries
- Rely on blog posts (use official HMRC only)
- Over-promise deductions
- Give specific tax advice for individual circumstances

## Resources

### Official HMRC
- Main guide: https://www.gov.uk/expenses-if-youre-self-employed
- Simplified expenses: https://www.gov.uk/simpler-income-tax-simplified-expenses
- Capital allowances: https://www.gov.uk/capital-allowances
- Mileage: https://www.gov.uk/government/publications/rates-and-allowances-travel-mileage-and-fuel-allowances

### Professional Bodies
- ICAEW (Chartered Accountants): https://www.icaew.com/
- CIOT (Chartered Institute of Taxation): https://www.tax.org.uk/

### Tax Software Providers (for reference)
- FreeAgent: https://www.freeagent.com/guides/
- QuickBooks: https://quickbooks.intuit.com/uk/blog/taxes/
- Xero: https://www.xero.com/uk/guides/

### Community
- MoneySavingExpert: https://www.moneysavingexpert.com/family/self-employed/
- Contractor UK: https://www.contractoruk.com/

---

**Last Updated**: 2025-11-30
**Next Review Due**: 2026-04-05 (before 2026/27 tax year)
