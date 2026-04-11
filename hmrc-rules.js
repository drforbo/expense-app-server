/**
 * HMRC Tax Rules Configuration
 *
 * IMPORTANT: This file contains UK HMRC tax rules for self-employed individuals
 * Last Updated: 2026-04-11
 * Tax Year: 2026/27
 *
 * SOURCES:
 * - HMRC Self-Employment Guide: https://www.gov.uk/expenses-if-youre-self-employed
 * - Simplified Expenses: https://www.gov.uk/simpler-income-tax-simplified-expenses
 * - Mileage Rates: https://www.gov.uk/government/publications/rates-and-allowances-travel-mileage-and-fuel-allowances
 * - Capital Allowances: https://www.gov.uk/capital-allowances
 * - Client Entertainment: https://www.gov.uk/expenses-if-youre-self-employed/food-and-drink
 *
 * REVIEW SCHEDULE:
 * - Check before each tax year (April 6th)
 * - Check after Budget announcements (usually March/October)
 * - Subscribe to HMRC updates: https://www.gov.uk/government/email-signup/new?email_signup%5Bfeed%5D=https://www.gov.uk/government/organisations/hm-revenue-customs.atom
 */

module.exports = {
  // Last update metadata
  metadata: {
    lastUpdated: '2026-04-11',
    taxYear: '2026/27',
    version: '1.3.0',
    reviewedBy: 'Added MTD ITSA phased thresholds, quarterly deadlines, and category-to-HMRC field mapping',
  },

  // Income tax rates and bands
  // Source: https://www.gov.uk/income-tax-rates
  income_tax: {
    personal_allowance: 12570,  // £12,570 (frozen until 2028)
    basic_rate: {
      rate: 0.20,  // 20%
      band: 37700,  // £37,700 (taxable income £0-£37,700, total income up to £50,270)
    },
    higher_rate: {
      rate: 0.40,  // 40%
      threshold: 50271,  // £50,271-£125,140
    },
    additional_rate: {
      rate: 0.45,  // 45%
      threshold: 125140,  // £125,140+
    },
    marriage_allowance: 1260,  // £1,260 transferable to spouse
    trading_allowance: 1000,  // £1,000 tax-free trading income
  },

  // National Insurance contributions for self-employed
  // Source: https://www.gov.uk/self-employed-national-insurance-rates
  national_insurance: {
    class_2: {
      rate_per_week: 3.45,  // £3.45/week
      small_profits_threshold: 6725,  // £6,725 annual
      note: 'Voluntary if profits below threshold, but pays for state pension eligibility',
    },
    class_4: {
      lower_rate: 0.06,  // 6% on profits between £12,570 and £50,270
      lower_threshold: 12570,
      upper_threshold: 50270,
      upper_rate: 0.02,  // 2% on profits above £50,270
    },
  },

  // Student loan repayment thresholds
  // Source: https://www.gov.uk/repaying-your-student-loan/what-you-pay
  student_loans: {
    plan_1: {
      threshold: 24990,  // £24,990
      rate: 0.09,  // 9%
    },
    plan_2: {
      threshold: 27295,  // £27,295
      rate: 0.09,  // 9%
    },
    plan_4: {
      threshold: 31395,  // £31,395
      rate: 0.09,  // 9%
    },
    postgraduate: {
      threshold: 21000,  // £21,000
      rate: 0.06,  // 6%
    },
  },

  // Making Tax Digital for Income Tax Self Assessment (MTD for ITSA)
  // Source: https://www.gov.uk/guidance/use-making-tax-digital-for-income-tax
  mtd_itsa: {
    mandatory_from: '2026-04-06',
    phases: {
      phase_1: { from: '2026-04-06', income_threshold: 50000 },  // £50,000+
      phase_2: { from: '2027-04-06', income_threshold: 30000 },  // £30,000+
      phase_3: { from: '2028-04-06', income_threshold: 20000 },  // £20,000+
    },
    soft_landing_2026_27: true,  // No penalty points for late quarterly updates in first year
    quarterly_deadlines_2026_27: {
      q1: { period: '2026-04-06 to 2026-07-05', due: '2026-08-07' },
      q2: { period: '2026-07-06 to 2026-10-05', due: '2026-11-07' },
      q3: { period: '2026-10-06 to 2027-01-05', due: '2027-02-07' },
      q4: { period: '2027-01-06 to 2027-04-05', due: '2027-05-07' },
      final_declaration: { due: '2028-01-31' },
    },
    note: 'Quarterly cumulative digital submissions required. Each update is year-to-date, not just the quarter.',
  },

  // Mapping from app expense categories to HMRC Self Employment (MTD) expense fields
  // Source: https://developer.service.hmrc.gov.uk/api-documentation/docs/api/service/self-employment-business-api/5.0
  // These are the 15 HMRC periodExpenses fields for quarterly/annual submissions
  category_to_hmrc_field: {
    // App categories → HMRC fields
    supplies:              'adminCosts',              // Office supplies, stationery
    software:              'adminCosts',              // Software, tools, subscriptions
    marketing:             'advertisingCosts',         // Advertising, promotions
    subsistence:           'otherExpenses',            // Overnight business travel meals
    travel:                'carVanTravelExpenses',     // Trains, flights, parking
    mileage:               'carVanTravelExpenses',     // Business mileage
    home_office:           'premisesRunningCosts',     // Rent, utilities for workspace
    professional_services: 'professionalFees',         // Accountant, lawyer fees
    training:              'otherExpenses',            // Courses, CPD
    insurance:             'premisesRunningCosts',     // Business insurance

    // Additional HMRC fields not yet covered by app categories
    // (may be added as the app grows):
    // costOfGoods           — goods bought for resale or materials used
    // paymentsToSubcontractors — CIS payments to subcontractors
    // wagesAndStaffCosts    — wages, salaries, employer NI contributions
    // maintenanceCosts      — repairs and renewals of property/equipment
    // businessEntertainmentCosts — NOT deductible, but reported separately
    // interestOnBankOtherLoans   — bank/credit card/HP interest
    // financeCharges        — bank charges, credit card fees
    // irrecoverableDebts    — bad debts written off
    // depreciation          — depreciation and loss/profit on asset sales
  },

  // For businesses with turnover under £90,000, HMRC allows a single
  // 'consolidatedExpenses' figure instead of the 15-field breakdown.
  consolidated_expenses_threshold: 90000,

  // Mileage allowance rates (HMRC Approved Mileage Allowance Payment)
  // Source: https://www.gov.uk/government/publications/rates-and-allowances-travel-mileage-and-fuel-allowances
  mileage: {
    cars_vans: {
      first_10k_miles: 0.45,  // 45p per mile
      over_10k_miles: 0.25,   // 25p per mile
    },
    motorcycles: 0.24,
    bicycles: 0.20,
  },

  // Simplified expenses for home office (Sole Traders only)
  // Source: https://www.gov.uk/simpler-income-tax-simplified-expenses/working-from-home
  simplified_expenses: {
    home_office: {
      sole_trader_weekly_rate: 6,  // £6 per week
      note: 'Flat rate - no receipts needed. Cannot claim actual costs if using this.',
    },
    vehicle: {
      // Simplified expenses for vehicles - alternative to actual costs
      note: 'Use mileage rates instead of actual costs (fuel, insurance, repairs)',
    },
  },

  // Food and meals rules (VERY STRICT for UK)
  // Source: https://www.gov.uk/expenses-if-youre-self-employed/food-and-drink
  food_and_meals: {
    client_entertainment: {
      deductible: false,
      explanation: 'Client meals and entertainment are NOT deductible in the UK (unlike US 50% rule)',
      examples: [
        'Taking client to lunch',
        'Coffee meeting with client',
        'Dinner with potential client',
      ],
    },
    day_to_day_meals: {
      deductible: false,
      explanation: 'Your own meals during normal working day are NOT deductible',
      examples: [
        'Lunch while working at desk',
        'Coffee while working',
        'Takeaway because working late',
      ],
    },
    overnight_subsistence: {
      deductible: true,
      explanation: 'Meals when traveling overnight for business',
      examples: [
        'Hotel breakfast during business trip',
        'Dinner during overnight conference',
      ],
    },
    temporary_workplace: {
      deductible: 'maybe',
      explanation: 'Meals at temporary workplace (< 24 months) MAY be deductible. Permanent workplace = NO.',
      note: 'Must be genuinely temporary, not routine commuting',
    },
  },

  // Client gifts limit
  // Source: https://www.gov.uk/expenses-if-youre-self-employed/gifts-to-customers
  gifts: {
    max_per_person_per_year: 50,  // £50
    must_display_business_name: true,
    cannot_be_food_drink_tobacco_vouchers: true,
  },

  // Capital allowances for equipment
  // Source: https://www.gov.uk/capital-allowances
  capital_allowances: {
    annual_investment_allowance: {
      limit: 1000000,  // £1m (temporary increase, check annually)
      note: 'Can claim 100% of qualifying equipment costs up to £1m in year of purchase',
    },
    wholly_and_exclusively: {
      rule: 'If equipment bought for business, 100% deductible even if some personal use',
      examples: [
        'Laptop bought for business (even if watch Netflix on it)',
        'Phone bought for business (even if personal calls)',
        'Camera for content creation (even if holiday photos)',
      ],
    },
  },

  // Commuting rules
  commuting: {
    permanent_workplace: {
      deductible: false,
      explanation: 'Travel to your permanent workplace is NOT deductible',
    },
    temporary_workplace: {
      deductible: true,
      explanation: 'Travel to temporary workplace (< 24 months) IS deductible',
    },
    business_travel: {
      deductible: true,
      explanation: 'Travel to client sites, meetings, etc. IS deductible',
    },
  },

  // Clothing rules
  clothing: {
    everyday_clothing: {
      deductible: false,
      explanation: 'Clothing you wear (even for work) is NOT deductible',
      examples: [
        'Suit for meetings',
        'Makeup to wear for filming',
        'Clothes for work events',
      ],
    },
    costume_uniform: {
      deductible: true,
      explanation: 'Costumes/uniforms that cannot be worn as everyday clothing',
      examples: [
        'Branded uniform with company logo',
        'Protective clothing (hard hat, hi-vis)',
      ],
    },
    content_props: {
      deductible: true,
      explanation: 'Items purchased TO REVIEW/FEATURE in content (not to wear)',
      examples: [
        'Makeup to review in video',
        'Clothes to review/feature in content',
      ],
    },
  },

  // Business structure specific rules
  business_structures: {
    sole_trader: {
      tax_return: 'Self Assessment',
      can_use_simplified_expenses: true,
      can_charge_self_rent: false,
      can_pay_self_salary: false,
      drawings_deductible: false,
      note: 'Simpler rules, but personally liable for all business debts',
    },
    limited_company: {
      tax_return: 'Corporation Tax (CT600) + Personal Self Assessment',
      can_use_simplified_expenses: false,
      can_charge_company_rent: true,
      can_pay_salary_dividends: true,
      benefits_in_kind_apply: true,
      note: 'More complex, but limited liability. Watch for IR35 if contractor.',
      warnings: {
        home_office: 'Company can pay rent, but triggers rental income tax personally',
        company_car: 'Triggers P11D benefit in kind tax',
        personal_expenses: 'Personal benefit from company expense = taxable benefit to you',
      },
    },
  },

  // Important updates to watch for
  important_dates: {
    tax_year_start: 'April 6th',
    budget_announcements: 'Usually March (Spring) and/or October (Autumn)',
    self_assessment_deadline: 'January 31st (online)',
  },

  // Common mistakes to avoid
  common_mistakes: [
    'Using US tax rules (50% meal deduction does NOT apply in UK)',
    'Claiming commuting costs',
    'Claiming client entertainment',
    'Claiming clothes to wear (even if for work)',
    'Claiming day-to-day meals',
    'Mixing up capital equipment (100% if for business) with ongoing bills (split by %)',
  ],
};
