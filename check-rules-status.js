#!/usr/bin/env node

/**
 * Check HMRC Rules Status
 *
 * Run this script to check if HMRC rules need reviewing:
 * node check-rules-status.js
 */

const hmrcRules = require('./hmrc-rules');
const fs = require('fs');

console.log('\n🔍 HMRC Rules Status Check\n');
console.log('='.repeat(60));

// Check last updated date
const lastUpdated = new Date(hmrcRules.metadata.lastUpdated);
const now = new Date();
const daysSinceUpdate = Math.floor((now - lastUpdated) / (1000 * 60 * 60 * 24));

console.log(`\n📅 Last Updated: ${hmrcRules.metadata.lastUpdated}`);
console.log(`   Tax Year: ${hmrcRules.metadata.taxYear}`);
console.log(`   Version: ${hmrcRules.metadata.version}`);
console.log(`   Reviewed By: ${hmrcRules.metadata.reviewedBy}`);
console.log(`   Days since update: ${daysSinceUpdate}`);

// Check if review is needed
const warnings = [];

// 1. Check if more than 6 months old
if (daysSinceUpdate > 180) {
  warnings.push({
    severity: 'HIGH',
    message: `Rules haven't been reviewed in ${daysSinceUpdate} days (6+ months)`,
    action: 'Review all rules against current HMRC guidance',
  });
}

// 2. Check if new tax year
const currentMonth = now.getMonth(); // 0-11
const currentDay = now.getDate();
if (currentMonth >= 3 && currentMonth < 10) { // April-October
  const taxYear = `${now.getFullYear()}/${(now.getFullYear() + 1).toString().slice(2)}`;
  if (hmrcRules.metadata.taxYear !== taxYear) {
    warnings.push({
      severity: 'HIGH',
      message: `Tax year mismatch: Rules are for ${hmrcRules.metadata.taxYear}, current is ${taxYear}`,
      action: 'Update rules for new tax year (check Budget announcements)',
    });
  }
}

// 3. Check for upcoming Budget dates
const budgetMonths = [2, 9]; // March (2), October (9)
if (budgetMonths.includes(currentMonth)) {
  warnings.push({
    severity: 'MEDIUM',
    message: `Budget month (${currentMonth === 2 ? 'March' : 'October'}) - check for announcements`,
    action: 'Review Budget for any tax changes affecting self-employed',
  });
}

// 4. Check mileage rates (rarely change, but important)
const currentMileageRate = hmrcRules.mileage.cars_vans.first_10k_miles;
if (currentMileageRate !== 0.45) {
  warnings.push({
    severity: 'INFO',
    message: `Mileage rate is ${currentMileageRate} (expected 0.45 as of 2024/25)`,
    action: 'Verify this is correct for current tax year',
  });
}

// 5. Check Annual Investment Allowance
const currentAIA = hmrcRules.capital_allowances.annual_investment_allowance.limit;
if (currentAIA === 1000000 && daysSinceUpdate > 365) {
  warnings.push({
    severity: 'MEDIUM',
    message: 'Annual Investment Allowance is £1m - this is a temporary increase',
    action: 'Check if this is still current (changes frequently)',
  });
}

// Display warnings
console.log('\n⚠️  Warnings:');
if (warnings.length === 0) {
  console.log('   ✅ No warnings - rules appear up to date');
} else {
  warnings.forEach((warning, i) => {
    console.log(`\n   ${i + 1}. [${warning.severity}] ${warning.message}`);
    console.log(`      → ${warning.action}`);
  });
}

// Summary
console.log('\n' + '='.repeat(60));
console.log('\n📋 Action Items:\n');

if (warnings.some(w => w.severity === 'HIGH')) {
  console.log('   ⚠️  URGENT: Review and update rules immediately');
  console.log('   1. Check HMRC guidance: https://www.gov.uk/expenses-if-youre-self-employed');
  console.log('   2. Update hmrc-rules.js with any changes');
  console.log('   3. Update server.js AI prompts to match');
  console.log('   4. Test categorization with affected transaction types');
}

if (warnings.some(w => w.severity === 'MEDIUM')) {
  console.log('   ⚠️  IMPORTANT: Schedule a review soon');
  console.log('   - Check Budget announcements');
  console.log('   - Verify key rates haven\'t changed');
}

if (warnings.length === 0 || warnings.every(w => w.severity === 'INFO')) {
  console.log('   ✅ Rules appear current');
  console.log('   - Next review: Before April 6th (start of tax year)');
  console.log('   - Subscribe to HMRC updates for changes');
}

console.log('\n📚 Resources:');
console.log('   - Maintenance guide: ./HMRC_RULES_MAINTENANCE.md');
console.log('   - HMRC expenses guide: https://www.gov.uk/expenses-if-youre-self-employed');
console.log('   - Mileage rates: https://www.gov.uk/government/publications/rates-and-allowances-travel-mileage-and-fuel-allowances');
console.log('   - HMRC updates: https://www.gov.uk/government/organisations/hm-revenue-customs/latest');

console.log('\n' + '='.repeat(60) + '\n');

// Exit with code based on severity
const hasHighWarnings = warnings.some(w => w.severity === 'HIGH');
const hasMediumWarnings = warnings.some(w => w.severity === 'MEDIUM');

if (hasHighWarnings) {
  process.exit(2); // High priority warnings
} else if (hasMediumWarnings) {
  process.exit(1); // Medium priority warnings
} else {
  process.exit(0); // All good
}
