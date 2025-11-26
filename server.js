const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Plaid client
const configuration = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(configuration);

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Initialize Supabase client (for regular operations with RLS)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Initialize Supabase admin client (for server-side operations, bypasses RLS)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Create link token
app.post('/api/create_link_token', async (req, res) => {
  try {
    const { userId } = req.body;
    console.log('📥 Creating link token for user:', userId);
    
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: 'bopp',
      products: ['transactions'],
      country_codes: ['GB'],
      language: 'en',
    });

    console.log('✅ Link token created successfully');
    res.json({ link_token: response.data.link_token });
  } catch (error) {
    console.error('❌ Error creating link token:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create sandbox access token (for testing without Plaid Link UI)
app.post('/api/create_sandbox_token', async (req, res) => {
  try {
    const { userId } = req.body;
    console.log('🔧 Creating sandbox access token for user:', userId);
    
    // Create a sandbox item (fake bank connection)
    const createResponse = await plaidClient.sandboxPublicTokenCreate({
      institution_id: 'ins_109508', // Chase (sandbox)
      initial_products: ['transactions'],
    });
    
    console.log('✅ Sandbox public token created');
    
    // Exchange for access token
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
      public_token: createResponse.data.public_token,
    });
    
    const access_token = exchangeResponse.data.access_token;
    console.log('✅ Access token obtained:', access_token.substring(0, 20) + '...');
    
    res.json({ 
      access_token,
      message: 'Sandbox bank connected'
    });
  } catch (error) {
    console.error('❌ Error creating sandbox token:', error);
    res.status(500).json({ error: error.message });
  }
});

// Exchange public token for access token
app.post('/api/exchange_public_token', async (req, res) => {
  try {
    const { public_token, userId } = req.body;
    console.log('🔄 Exchanging public token for user:', userId);
    
    const response = await plaidClient.itemPublicTokenExchange({
      public_token: public_token,
    });

    const access_token = response.data.access_token;
    const item_id = response.data.item_id;

    console.log('✅ Access token obtained');
    res.json({ 
      access_token,
      item_id,
      message: 'Bank connected successfully'
    });
  } catch (error) {
    console.error('❌ Error exchanging token:', error);
    res.status(500).json({ error: error.message });
  }
});

// Sync transactions from Plaid using the Sync API (better for sandbox)
app.post('/api/sync_transactions', async (req, res) => {
  try {
    const { access_token, useMockData = false, user_id } = req.body;
    console.log('📊 Syncing transactions from Plaid sandbox...');

    let allTransactions = [];

    // For testing: Always use mock data for consistent IDs
    if (useMockData) {
      console.log('🧪 Using mock data for testing (consistent transaction IDs)...');

      const today = new Date();
      const mockTransactions = [
        // EXPENSES
        {
          transaction_id: 'mock-exp-1',
          name: 'Canon Camera Store',
          merchant_name: 'Canon UK',
          amount: 1299.00,
          date: new Date(today.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Shops', 'Electronics']
        },
        {
          transaction_id: 'mock-exp-2',
          name: 'Ring Light Pro',
          merchant_name: 'Amazon',
          amount: 79.99,
          date: new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Shops', 'Electronics']
        },
        {
          transaction_id: 'mock-exp-3',
          name: 'Notion Pro',
          merchant_name: 'Notion Labs',
          amount: 8.00,
          date: new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Service', 'Software Subscription']
        },
        {
          transaction_id: 'mock-exp-4',
          name: 'Leon Restaurant',
          merchant_name: 'Leon',
          amount: 15.50,
          date: new Date(today.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Food and Drink', 'Restaurants']
        },
        {
          transaction_id: 'mock-exp-5',
          name: 'Deliveroo Order',
          merchant_name: 'Deliveroo',
          amount: 28.90,
          date: new Date(today.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Food and Drink', 'Food Delivery']
        },
        {
          transaction_id: 'mock-exp-6',
          name: 'BP Petrol',
          merchant_name: 'BP',
          amount: 45.20,
          date: new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Travel', 'Gas Stations']
        },
        {
          transaction_id: 'mock-exp-7',
          name: 'WeWork Hot Desk',
          merchant_name: 'WeWork',
          amount: 35.00,
          date: new Date(today.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Service', 'Workspace']
        },
        {
          transaction_id: 'mock-exp-8',
          name: 'Udemy Course',
          merchant_name: 'Udemy',
          amount: 89.99,
          date: new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Service', 'Education']
        },
        {
          transaction_id: 'mock-exp-9',
          name: 'Microphone USB',
          merchant_name: 'Scan Computers',
          amount: 129.00,
          date: new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Shops', 'Electronics']
        },
        {
          transaction_id: 'mock-exp-10',
          name: 'Instagram Ads',
          merchant_name: 'Meta Platforms',
          amount: 250.00,
          date: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Service', 'Advertising']
        },
        {
          transaction_id: 'mock-exp-11',
          name: 'Stationery',
          merchant_name: 'Ryman',
          amount: 22.40,
          date: new Date(today.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Shops', 'Office Supplies']
        },
        {
          transaction_id: 'mock-exp-12',
          name: 'Canva Pro',
          merchant_name: 'Canva',
          amount: 10.99,
          date: new Date(today.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Service', 'Software Subscription']
        },
        {
          transaction_id: 'mock-exp-13',
          name: 'Train Ticket',
          merchant_name: 'Trainline',
          amount: 67.50,
          date: new Date(today.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Travel', 'Public Transport']
        },
        {
          transaction_id: 'mock-exp-14',
          name: 'Accountant Fee',
          merchant_name: 'Smith & Co Accounting',
          amount: 300.00,
          date: new Date(today.getTime() - 9 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Service', 'Professional Services']
        },
        {
          transaction_id: 'mock-exp-15',
          name: 'Zara',
          merchant_name: 'Zara',
          amount: 89.99,
          date: new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Shops', 'Clothing']
        },

        // INCOME TRANSACTIONS (negative amounts = credits in Plaid)
        {
          transaction_id: 'mock-income-1',
          name: 'TikTok Creator Fund',
          merchant_name: 'TikTok Ltd',
          amount: -320.50,
          date: new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Transfer', 'Deposit']
        },
        {
          transaction_id: 'mock-income-2',
          name: 'Sponsorship Deal',
          merchant_name: 'GlowUp Beauty',
          amount: -2500.00,
          date: new Date(today.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Transfer', 'Deposit']
        },
        {
          transaction_id: 'mock-income-3',
          name: 'Freelance Project',
          merchant_name: 'Digital Agency Ltd',
          amount: -1750.00,
          date: new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Transfer', 'Deposit']
        },
        {
          transaction_id: 'mock-income-4',
          name: 'Affiliate Payout',
          merchant_name: 'Amazon Associates',
          amount: -187.30,
          date: new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Transfer', 'Deposit']
        },
        {
          transaction_id: 'mock-income-5',
          name: 'Bank Transfer',
          merchant_name: 'Sarah Johnson',
          amount: -50.00,
          date: new Date(today.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          category: ['Transfer', 'Deposit']
        }
      ];

      allTransactions = mockTransactions;
      console.log('✅ Using 20 mock transactions (15 expenses + 5 income)');
    } else {
      // Use real Plaid data - only last 30 days
      console.log('🔄 Fetching real Plaid transactions (last 30 days)...');

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      let hasMore = true;
      let cursor = null;
      let batchCount = 0;
      const maxBatches = 5; // Limit to prevent infinite loops

      while (hasMore && batchCount < maxBatches) {
        const request = {
          access_token: access_token,
        };

        if (cursor) {
          request.cursor = cursor;
        }

        const response = await plaidClient.transactionsSync(request);

        const { added, modified, removed, next_cursor, has_more } = response.data;

        // Filter to only last 30 days
        const recentAdded = added.filter(t => {
          const txDate = new Date(t.date);
          return txDate >= thirtyDaysAgo;
        });

        allTransactions = allTransactions.concat(recentAdded);
        hasMore = has_more;
        cursor = next_cursor;
        batchCount++;

        console.log(`📥 Batch ${batchCount}: ${recentAdded.length}/${added.length} recent transactions`);

        // Stop if we've gone past 30 days
        if (added.length > 0 && added.every(t => new Date(t.date) < thirtyDaysAgo)) {
          console.log('⏹️  Reached transactions older than 30 days, stopping');
          break;
        }
      }

      console.log(`✅ Total found from Plaid (last 30 days): ${allTransactions.length} transactions`);

      // If sandbox still returns 0 transactions, use mock data as fallback
      if (allTransactions.length === 0) {
        console.log('⚠️  No transactions from Plaid, falling back to mock data...');

        const today = new Date();
        const mockTransactions = [
          {
            transaction_id: 'mock-1',
            name: 'Boots',
            merchant_name: 'Boots',
            amount: 24.99,
            date: new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            category: ['Shops', 'Health and Beauty']
          },
          {
            transaction_id: 'mock-2',
            name: 'Tesco',
            merchant_name: 'Tesco',
            amount: 45.20,
            date: new Date(today.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            category: ['Food and Drink', 'Groceries']
          },
          {
            transaction_id: 'mock-3',
            name: 'Amazon',
            merchant_name: 'Amazon',
            amount: 89.99,
            date: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            category: ['Shops', 'Digital Purchase']
          },
          {
            transaction_id: 'mock-4',
            name: 'Starbucks',
            merchant_name: 'Starbucks',
            amount: 4.50,
            date: new Date(today.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            category: ['Food and Drink', 'Restaurants', 'Coffee Shop']
          },
          {
            transaction_id: 'mock-5',
            name: 'Shell',
            merchant_name: 'Shell',
            amount: 52.00,
            date: new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            category: ['Travel', 'Gas Stations']
          },
          {
            transaction_id: 'mock-6',
            name: 'Currys',
            merchant_name: 'Currys',
            amount: 299.99,
            date: new Date(today.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            category: ['Shops', 'Electronics']
          },
          {
            transaction_id: 'mock-7',
            name: 'Sainsburys',
            merchant_name: 'Sainsburys',
            amount: 38.45,
            date: new Date(today.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            category: ['Food and Drink', 'Groceries']
          },
          {
            transaction_id: 'mock-8',
            name: 'Adobe Creative Cloud',
            merchant_name: 'Adobe',
            amount: 54.99,
            date: new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            category: ['Service', 'Subscription']
          },
          {
            transaction_id: 'mock-9',
            name: 'Pret A Manger',
            merchant_name: 'Pret A Manger',
            amount: 8.75,
            date: new Date(today.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            category: ['Food and Drink', 'Restaurants']
          },
          {
            transaction_id: 'mock-10',
            name: 'Uber',
            merchant_name: 'Uber',
            amount: 15.20,
            date: new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            category: ['Travel', 'Taxi']
          },
          {
            transaction_id: 'mock-11',
            name: 'Apple Store',
            merchant_name: 'Apple',
            amount: 129.00,
            date: new Date(today.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            category: ['Shops', 'Electronics']
          },
          {
            transaction_id: 'mock-12',
            name: 'Waterstones',
            merchant_name: 'Waterstones',
            amount: 22.99,
            date: new Date(today.getTime() - 9 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            category: ['Shops', 'Bookstores']
          },
          {
            transaction_id: 'mock-13',
            name: 'Costa Coffee',
            merchant_name: 'Costa',
            amount: 5.20,
            date: new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            category: ['Food and Drink', 'Coffee Shop']
          },
          {
            transaction_id: 'mock-14',
            name: 'Argos',
            merchant_name: 'Argos',
            amount: 67.50,
            date: new Date(today.getTime() - 11 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            category: ['Shops', 'General Merchandise']
          },
          {
            transaction_id: 'mock-15',
            name: 'EE Mobile',
            merchant_name: 'EE',
            amount: 35.00,
            date: new Date(today.getTime() - 12 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            category: ['Service', 'Mobile Phone']
          }
        ];

        allTransactions = mockTransactions;
        console.log('✅ Using 15 mock transactions');
      }
    }

    // Sort by date descending (newest first)
    const sortedTransactions = allTransactions.sort((a, b) =>
      new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    // Filter out already categorized transactions if user_id is provided
    let finalTransactions = sortedTransactions;
    if (user_id) {
      try {
        console.log('🔍 Filtering out categorized transactions for user:', user_id);

        const { data: categorizedData, error } = await supabaseAdmin
          .from('categorized_transactions')
          .select('plaid_transaction_id')
          .eq('user_id', user_id);

        if (error) {
          console.error('⚠️  Error fetching categorized transactions:', error);
        } else {
          const categorizedIds = new Set(
            categorizedData?.map(t => t.plaid_transaction_id) || []
          );

          console.log(`📋 Found ${categorizedIds.size} categorized transaction IDs in Supabase`);
          if (categorizedIds.size > 0 && categorizedIds.size <= 10) {
            console.log(`🔍 Categorized IDs:`, Array.from(categorizedIds));
          }

          // Pre-compute split transaction base IDs for faster lookup
          const splitTransactionBaseIds = new Set();
          for (const id of categorizedIds) {
            if (id.includes('_split_')) {
              const baseId = id.substring(0, id.indexOf('_split_'));
              splitTransactionBaseIds.add(baseId);
            }
          }

          // Filter uncategorized transactions
          finalTransactions = sortedTransactions.filter(t => {
            // Check exact match
            if (categorizedIds.has(t.transaction_id)) return false;

            // Check if this is a split transaction
            if (splitTransactionBaseIds.has(t.transaction_id)) return false;

            return true;
          });

          console.log(`✅ Filtered: ${sortedTransactions.length} total → ${finalTransactions.length} uncategorized`);
        }
      } catch (err) {
        console.error('❌ Error during filtering:', err);
        // If filtering fails, return all transactions
      }
    }

    res.json({
      transactions: finalTransactions,
      count: finalTransactions.length
    });
  } catch (error) {
    console.error('❌ Error syncing transactions:', error.response?.data || error);
    res.status(500).json({
      error: error.message,
      details: error.response?.data
    });
  }
});

// Generate contextual questions for a transaction
app.post('/api/generate_questions', async (req, res) => {
  try {
    const { transaction, userProfile, previousAnswers = {} } = req.body;
    console.log('❓ Generating questions for:', transaction.name || transaction.merchant_name);
    console.log('📋 User profile:', userProfile);
    console.log('💬 Previous answers:', previousAnswers);

    const workTypeDesc = userProfile?.work_type === 'content_creation' ? 'content creator'
      : userProfile?.work_type === 'freelancing' ? 'freelancer'
      : userProfile?.work_type === 'side_hustle' ? 'side hustler'
      : userProfile?.custom_work_type || 'self-employed';

    // Check if this is income (positive amount) or expense (negative amount)
    const isIncome = transaction.amount < 0; // Plaid uses negative for income credits
    console.log(`💰 Transaction type: ${isIncome ? 'INCOME' : 'EXPENSE'}`);

    // Check how many questions have been answered
    const numAnswered = Object.keys(previousAnswers).length;
    const hasPreviousAnswers = numAnswered > 0;

    // INCOME FLOW - Different questions for income categorization
    if (isIncome) {
      // CRITICAL: Check for personal income keywords in Q1 answer BEFORE calling AI
      if (numAnswered === 1) {
        const q1Answer = Object.values(previousAnswers)[0]?.toLowerCase() || '';
        const personalKeywords = [
          'friend', 'family', 'paying me back', 'paying back', 'paid me back',
          'reimbursement', 'reimburse', 'gift', 'personal transfer', 'personal',
          'dinner', 'lunch', 'expense', 'borrowed', 'owe', 'owed', 'repay',
          'repaying', 'split', 'share', 'shared'
        ];

        const isPersonalIncome = personalKeywords.some(keyword => q1Answer.includes(keyword));

        if (isPersonalIncome) {
          console.log('🏠 Personal income detected in Q1:', q1Answer);
          console.log('✅ Skipping Q2 - ready to categorize as personal income');
          res.json({ questions: [] });
          return;
        }
      }

      // CRITICAL: If we have 2 answers for business income, we're done
      if (numAnswered >= 2) {
        console.log('✅ Income: 2 questions answered, ready to categorize');
        res.json({ questions: [] });
        return;
      }

      const incomePrompt = hasPreviousAnswers
        ? `You are a UK tax assistant helping a ${workTypeDesc} categorize income.

USER PROFILE:
- Work type: ${workTypeDesc}
- Monthly income: £${userProfile?.monthly_income || 'unknown'}
- Has international income: ${userProfile?.has_international_income ? 'Yes' : 'No'}

TRANSACTION (INCOME):
- Merchant/Payer: ${transaction.merchant_name || transaction.name}
- Amount: £${Math.abs(transaction.amount)}
- Date: ${transaction.date}
- Plaid Category: ${transaction.category?.join(', ') || 'Unknown'}

PREVIOUS ANSWERS:
${JSON.stringify(previousAnswers, null, 2)}

NUMBER OF ANSWERS: ${numAnswered}

YOUR GOAL: Check if we need more questions or can categorize.

STEP 1: Check Q1 answer - is this PERSONAL or BUSINESS income?

PERSONAL INCOME indicators (stop asking questions):
- "Friend/family paying me back"
- "Personal transfer"
- "Gift"
- "Reimbursement"
- "Friend paying me back for dinner"
- Any mention of friends, family, personal, gift, paying back

If Q1 indicates PERSONAL → Return empty questions [] (ready to categorize as personal)

BUSINESS INCOME (ask Q2):
- Only ask Q2 if Q1 indicated business income (sponsorship, client, platform revenue, etc.)
- Q2: "What type of income is this?" with business categories

STEP 2: If Q1 was business income and we have 2 answers:
- Return empty questions [] (ready to categorize)

If Q2 answer was "Other income" → Ask ONE more question:
{
  "questions": [
    {
      "text": "Can you briefly describe what this income was for?",
      "options": []
    }
  ]
}

CRITICAL: Respond with ONLY valid JSON. No text before or after.

If personal income detected OR we have enough business income info:
{
  "questions": []
}

If Q1 was business income and we need Q2:
{
  "questions": [
    {
      "text": "What type of income is this?",
      "options": ["Based on work type - see Q2 examples"]
    }
  ]
}`
        : (numAnswered === 1
          ? `You are a UK tax assistant helping a ${workTypeDesc} categorize income.

USER PROFILE:
- Work type: ${workTypeDesc}
- Monthly income: £${userProfile?.monthly_income || 'unknown'}
- Has international income: ${userProfile?.has_international_income ? 'Yes' : 'No'}

TRANSACTION (INCOME):
- Merchant/Payer: ${transaction.merchant_name || transaction.name}
- Amount: £${Math.abs(transaction.amount)}
- Date: ${transaction.date}

ANSWER TO Q1 ("What is this income for?"):
${JSON.stringify(previousAnswers, null, 2)}

YOUR GOAL: Check if Q1 indicates PERSONAL or BUSINESS income.

STEP 1: Analyze the Q1 answer carefully.

PERSONAL INCOME indicators (stop asking questions - return empty array):
- Contains words: "friend", "family", "paying me back", "paying back", "reimbursement", "reimburse"
- Contains words: "gift", "personal transfer", "personal", "dinner", "lunch", "expense"
- Contains words: "borrowed", "owe", "owed", "repay", "repaying"
- Describes a non-business personal transaction

BUSINESS INCOME indicators (ask Q2):
- Client payments, sponsorships, brand deals
- Platform revenue (YouTube, TikTok, etc.)
- Sales, commissions, fees
- Any work-related income

STEP 2: Decide what to return.

If PERSONAL INCOME detected in Q1:
{
  "questions": []
}

If BUSINESS INCOME detected in Q1:
{
  "questions": [
    {
      "text": "What type of income is this?",
      "options": [/* business options based on work type */]
    }
  ]
}

QUESTION 2 OPTIONS (only if business income):

For content_creation:
- "Sponsorship or brand deal"
- "Ad revenue (YouTube, TikTok, etc.)"
- "Affiliate commissions"
- "Client work or consulting"
- "Product or merchandise sales"
- "Other income"

For freelancing:
- "Client fees or project payment"
- "Retainer or ongoing contract"
- "Commission or referral fee"
- "Consulting or advisory work"
- "Product or service sales"
- "Other income"

For side_hustle or general:
- "Sales or revenue"
- "Client payment"
- "Commission or referral fee"
- "Service fees"
- "Product sales"
- "Other income"

CRITICAL:
1. Check Q1 answer for personal income keywords FIRST
2. Respond with ONLY valid JSON
3. Return empty questions [] if personal income detected`
          : `You are a UK tax assistant helping a ${workTypeDesc} categorize income.

USER PROFILE:
- Work type: ${workTypeDesc}
- Monthly income: £${userProfile?.monthly_income || 'unknown'}
- Has international income: ${userProfile?.has_international_income ? 'Yes' : 'No'}

TRANSACTION (INCOME):
- Merchant/Payer: ${transaction.merchant_name || transaction.name}
- Amount: £${Math.abs(transaction.amount)}
- Date: ${transaction.date}
- Plaid Category: ${transaction.category?.join(', ') || 'Unknown'}

YOUR GOAL: Generate Q1 ONLY - ask what this income is for.

QUESTION 1: "What is this income for?"
- Generate 4-5 SPECIFIC suggestions based on:
  * The merchant/payer name (${transaction.merchant_name || transaction.name})
  * The transaction amount (£${Math.abs(transaction.amount)})
  * What this ${workTypeDesc} typically receives income from
  * Include BOTH business AND personal income options

EXAMPLES:

For content_creation work type:

YouTube payment (£500):
Q1: "What is this income for?"
- "YouTube/Google ad revenue"
- "Brand sponsorship payment"
- "Friend/family paying me back"
- "Gift or personal transfer"

Brand Studio Ltd (£1200):
Q1: "What is this income for?"
- "Brand partnership/sponsorship"
- "Client project payment"
- "Friend paying me back for dinner/expense"
- "Personal transfer"

Unknown transfer (£50):
Q1: "What is this income for?"
- "Friend/family reimbursement"
- "Gift or personal money"
- "Affiliate commission"
- "Small client payment"

For freelancing work type:

Bank transfer (£2000):
Q1: "What is this income for?"
- "Client project payment"
- "Retainer or ongoing contract"
- "Friend/family transfer"
- "Personal reimbursement"

PayPal payment (£500):
Q1: "What is this income for?"
- "Client invoice payment"
- "Freelance platform payment"
- "Personal transfer from friend/family"
- "Gift"

IMPORTANT RULES:
- Make suggestions specific to the payer name and amount
- ALWAYS include personal/non-business options like:
  * "Friend/family paying me back"
  * "Personal transfer"
  * "Gift"
  * "Reimbursement"
- Include common business income for ${workTypeDesc}
- Provide exactly 4 options

Respond with ONLY valid JSON:
{
  "questions": [
    {
      "text": "What is this income for?",
      "options": ["specific option 1", "specific option 2", "personal option", "another option"]
    }
  ]
}`);

      const message = await anthropic.messages.create({
        model: "claude-3-5-haiku-20241022",
        max_tokens: 500,
        messages: [{ role: "user", content: incomePrompt }]
      });

      let responseText = message.content[0].text;
      responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

      // Try to extract JSON if there's extra text (find first { to last })
      const firstBrace = responseText.indexOf('{');
      const lastBrace = responseText.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
        responseText = responseText.substring(firstBrace, lastBrace + 1);
      }

      let questions;
      try {
        questions = JSON.parse(responseText);
      } catch (parseError) {
        console.error('❌ Failed to parse JSON. Raw response:', responseText);
        throw parseError;
      }

      console.log('✅ Generated', questions.questions.length, 'income questions');
      res.json(questions);
      return;
    }

    // EXPENSE FLOW - Original flow for expenses
    const prompt = hasPreviousAnswers
      ? (numAnswered === 1
        ? `You are a UK tax assistant helping a ${workTypeDesc} categorize expenses.

USER PROFILE:
- Work type: ${workTypeDesc}
- Monthly income: £${userProfile?.monthly_income || 'unknown'}
- Time commitment: ${userProfile?.time_commitment || 'unknown'}
- Receives gifted items: ${userProfile?.receives_gifted_items ? 'Yes' : 'No'}

TRANSACTION:
- Merchant: ${transaction.merchant_name || transaction.name}
- Amount: £${Math.abs(transaction.amount)}
- Date: ${transaction.date}
- Plaid Category: ${transaction.category?.join(', ') || 'Unknown'}

PREVIOUS ANSWER TO Q1 ("What did you buy?"):
${JSON.stringify(previousAnswers, null, 2)}

YOUR GOAL: Detect if Q1 is SINGLE ITEM or MULTIPLE ITEMS, then generate appropriate Q2.

STEP 1: Analyze Q1 answer - is it single or multiple?

SINGLE ITEM indicators:
- Specific product names: "Laptop", "Foundation", "Camera", "Coffee", "Ring light"
- Singular items: "A bike", "Phone", "Sandwich"
- Specific equipment/supplies

MULTIPLE ITEMS indicators:
- Shopping language: "Weekly food shop", "Big shop", "Shopping", "Groceries"
- Plural/multiple: "Multiple items", "Various things", "Several products", "Mix of..."
- Generic: "Household essentials", "Weekly shop (multiple items)"

STEP 2: Generate Q2 based on detection:

IF SINGLE ITEM:
Q2: "What will you use this [item] for?" OR "What is this [item] for?"
- Reference the specific item from Q1
- Include 4 options with HMRC-accurate scenarios
- Mix of personal AND business options

Example - Q1 answer: "Foundation"
Q2: "What is this foundation for?"
- "To review or feature in a video" (100% business)
- "To wear for work events/filming" (personal - HMRC: personal grooming)
- "Everyday personal use" (personal)
- "As props for set dressing" (100% business)

Example - Q1 answer: "Laptop"
Q2: "What will you use this laptop for?"
- "Personal use and entertainment" (personal)
- "Editing videos/content for my channel" (100% business)
- "Work and personal use" (100% business - bought for business)
- "Running my business" (100% business)

IF MULTIPLE ITEMS:
Q2: Ask if ANY were for business (personalized to work type)

Work type: content_creation
Q2: "Did any of this include items for your content?"
- "No, all personal"
- "Yes - all for my content"
- "Yes - some items were for content"

Work type: freelancing
Q2: "Did any of this include items for client work or projects?"
- "No, all personal"
- "Yes - all for my work"
- "Yes - some items were for work"

Work type: side_hustle
Q2: "Did any of this include items for your side hustle?"
- "No, all personal"
- "Yes - all for my side hustle"
- "Yes - some items were for my side hustle"

Work type: (other)
Q2: "Did any of this include items for your business?"
- "No, all personal"
- "Yes - all for my business"
- "Yes - some items were for business"

IMPORTANT:
- Analyze the Q1 answer text to detect single vs multiple
- Use friendly, personalized language based on ${workTypeDesc}
- Always return exactly ONE question

CRITICAL: Respond with ONLY valid JSON. No text before or after. Start with { and end with }.

{
  "questions": [
    {
      "text": "Contextual Q2 referencing the item from Q1",
      "options": ["personal scenario", "business scenario", "another option", "fourth option"]
    }
  ]
}

OR if asking text input question:

{
  "questions": [
    {
      "text": "What did you buy for your content and approximately how much did those items cost in total?",
      "options": []
    }
  ]
}`
        : `You are a UK tax assistant helping a ${workTypeDesc} categorize expenses.

USER PROFILE:
- Work type: ${workTypeDesc}
- Monthly income: £${userProfile?.monthly_income || 'unknown'}
- Time commitment: ${userProfile?.time_commitment || 'unknown'}
- Receives gifted items: ${userProfile?.receives_gifted_items ? 'Yes' : 'No'}

TRANSACTION:
- Merchant: ${transaction.merchant_name || transaction.name}
- Amount: £${Math.abs(transaction.amount)}
- Date: ${transaction.date}
- Plaid Category: ${transaction.category?.join(', ') || 'Unknown'}

PREVIOUS ANSWERS:
${JSON.stringify(previousAnswers, null, 2)}

NUMBER OF ANSWERS: ${numAnswered}

YOUR GOAL: Check if we have enough info to categorize. ALMOST NEVER ask follow-up questions.

CRITICAL: If we already have 3 or more answers, STOP. Return empty questions array [] - we have enough info!

Ask a follow-up in these 2 cases ONLY (and only if we have fewer than 3 answers):

1. VEHICLE/MILEAGE TRACKING:
   If they said VEHICLE for business use AND we've only asked 2 questions so far:
   - "Delivery work", "Business travel", "Courier work", "Bike for deliveries"
   → Ask ONCE about mileage tracking (important for HMRC)

   But if we already asked the mileage question (3 answers), DO NOT ask again!

2. MIXED SHOPPING - CRITICAL - "some items":
   If Q2 answer contains ANY of: "some items", "some things", "Yes - some", "some of"
   → MUST ask ONE TEXT INPUT QUESTION (no options):

   For content_creation: "What did you buy for your content and approximately how much did those items cost in total?"
   For freelancing: "What did you buy for your work and approximately how much did those items cost in total?"
   For side_hustle: "What did you buy for your side hustle and approximately how much did those items cost in total?"
   For general: "What did you buy for your business and approximately how much did those items cost in total?"

   Options: [] (empty array - user will type freely)

   Example user input: "Foundation for filming and ring light - about £45 total"

   IMPORTANT: If they said "some items" you MUST ask this question. DO NOT proceed to categorization without getting the details and cost.

3. ALL OTHER CASES:
   → Return empty questions array [] - we have enough info!

   Examples of NO follow-up needed:
   - "No, all personal" → Categorize as personal
   - "Yes - all for my content" → Categorize as 100% business
   - Single product answered → Categorize based on purpose
   - Already have 3 answers → ALWAYS stop, proceed to categorization
   - Mileage question already answered → Proceed to categorization

HANDLE AUTOMATICALLY (no questions):
- Home office: Use HMRC simplified expenses (£6/week for working from home)
- Equipment: 100% business if bought for business
- Phone/internet: 100% business if mentioned for work
- Single-purpose items: laptop, makeup to review, coffee for meeting, etc.

EXAMPLES - NO FOLLOW-UP NEEDED:
- "Laptop" + "For work" → NO FOLLOW-UP (100% business)
- "Camera" + "Content creation" → NO FOLLOW-UP (100% business)
- "Makeup" + "To review in video" → NO FOLLOW-UP (100% business)
- "Foundation" + "Personal use" → NO FOLLOW-UP (0% personal)
- "Coffee" + "Business meeting" → NO FOLLOW-UP (50% by HMRC rule)

EXAMPLES - FOLLOW-UP NEEDED:

Mixed shopping with "some items":
- Q1="Weekly food shop" Q2="Did any of this include items for your content?" A="Yes - some items were for content"
  → ASK Q3 (text input, no options): "What did you buy for your content and approximately how much did those items cost in total?"
  User types: "Foundation for filming and ring light - about £45 total"

Vehicle mileage:
- Q1="Bike" Q2="What will you use this bike for?" A="Delivery work"
  → ASK Q3: "Do you track your business mileage?"
  - "Yes, I keep a mileage log"
  - "No, but I can estimate"
  - "I use it for all my deliveries"
  - "I don't track it"

IMPORTANT: Single-purpose transactions need NO follow-up. Only ask for mixed shopping or vehicles.

RESPONSE RULES:
- Generate ONLY 1 NEW question
- Make it specific to their previous answer
- Include options for most questions
- For text input questions (where user describes items/costs), return empty options array []

EXAMPLES:

Previous: Q1="Weekly food shop" Q2="Did any of this include items for your content?" A="Yes - some items were for content"
Next question (text input): "What did you buy for your content and approximately how much did those items cost in total?"
Options: [] (empty - user types freely)

Previous: Q1="Weekly food shop" Q2="Did any of this include items for your content?" A="No, all personal"
Next question: [] (empty - proceed to categorization as 100% personal)

Previous: Q1="Weekly food shop" Q2="Did any of this include items for your content?" A="Yes - all for my content"
Next question: [] (empty - proceed to categorization as 100% business)

Previous: Q1="Bike" Q2="Delivery/business travel"
Next question: "Do you track your business mileage?"
- "Yes, I keep a mileage log"
- "No, but I can estimate"
- "I use it for all my deliveries"
- "I don't track it"

Previous: Q1="Foundation" Q2="To review in a video"
Next question: NONE - 100% business, proceed to categorization

Previous: Q1="Laptop" Q2="For work and some personal use"
Next question: NONE - Bought with business intent = 100% business

Previous: Q1="Camera" Q2="Creating content"
Next question: NONE - 100% business

CRITICAL: Respond with ONLY valid JSON. No text before or after. Start with { and end with }.

If asking text input question (e.g., for "some items"):
{
  "questions": [
    {
      "text": "What did you buy for your content and approximately how much did those items cost in total?",
      "options": []
    }
  ]
}

If asking options question (e.g., mileage):
{
  "questions": [
    {
      "text": "Do you track your business mileage?",
      "options": ["Yes, I keep a mileage log", "No, but I can estimate", "I use it for all my deliveries", "I don't track it"]
    }
  ]
}

If no more questions needed:
{
  "questions": []
}`)
      : `You are a UK tax assistant helping a ${workTypeDesc} categorize expenses.

USER PROFILE:
- Work type: ${workTypeDesc}
- Monthly income: £${userProfile?.monthly_income || 'unknown'}
- Time commitment: ${userProfile?.time_commitment || 'unknown'}
- Receives gifted items: ${userProfile?.receives_gifted_items ? 'Yes' : 'No'}

TRANSACTION:
- Merchant: ${transaction.merchant_name || transaction.name}
- Amount: £${Math.abs(transaction.amount)}
- Date: ${transaction.date}
- Plaid Category: ${transaction.category?.join(', ') || 'Unknown'}

YOUR GOAL: Generate Q1 ONLY - ask what they bought.

QUESTION 1: "What did you buy?"
- Generate 4 SPECIFIC suggestions based on:
  * The merchant name (${transaction.merchant_name || transaction.name})
  * The transaction amount (£${Math.abs(transaction.amount)})
  * What this merchant typically sells
  * Include BOTH specific items AND general shopping options
  * Include BOTH personal AND business-relevant items for a ${workTypeDesc}

EXAMPLES:

Boots (£25):
Q1: "What did you buy?"
- "Makeup/foundation"
- "Skincare products"
- "Weekly shop (multiple items)"
- "Health/pharmacy items"

Starbucks (£4.50):
Q1: "What did you buy?"
- "Coffee/drink"
- "Coffee + food"
- "Multiple drinks/snacks"
- "Meeting with food/drinks"

Currys (£300):
Q1: "What did you buy?"
- "Laptop/computer"
- "Camera/video equipment"
- "Phone/tablet"
- "Multiple items/accessories"

Tesco (£45):
Q1: "What did you buy?"
- "Weekly food shop"
- "Specific ingredients"
- "Household essentials"
- "Mix of groceries/other items"

IMPORTANT RULES:
- Always include at least one "multiple items" or "shopping" option
- Include specific single item suggestions
- Make suggestions specific to what this merchant sells
- Include BOTH personal AND business-relevant options

Respond with ONLY valid JSON with ONE question:
{
  "questions": [
    {
      "text": "What did you buy?",
      "options": ["specific option 1", "specific option 2", "multiple items option", "specific option 4"]
    }
  ]
}`;

    const message = await anthropic.messages.create({
      model: "claude-3-5-haiku-20241022", // Use Haiku for faster question generation
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }]
    });

    let responseText = message.content[0].text;

    // Strip markdown code blocks if present
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    // Try to extract JSON if there's extra text (find first { to last })
    const firstBrace = responseText.indexOf('{');
    const lastBrace = responseText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
      responseText = responseText.substring(firstBrace, lastBrace + 1);
    }

    let questions;
    try {
      questions = JSON.parse(responseText);
    } catch (parseError) {
      console.error('❌ Failed to parse JSON. Raw response:', responseText);
      throw parseError;
    }

    console.log('✅ Generated', questions.questions.length, 'questions');
    res.json(questions);
  } catch (error) {
    console.error('❌ Error generating questions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Categorize transaction based on user's answers
app.post('/api/categorize_from_answers', async (req, res) => {
  try {
    const { transaction, answers, userProfile } = req.body;
    console.log('🤖 Categorizing with answers:', transaction.name);
    console.log('📋 User profile:', userProfile);
    console.log('💬 Answers:', answers);

    const workTypeDesc = userProfile?.work_type === 'content_creation' ? 'content creator'
      : userProfile?.work_type === 'freelancing' ? 'freelancer'
      : userProfile?.work_type === 'side_hustle' ? 'side hustler'
      : userProfile?.custom_work_type || 'self-employed';

    // Check if this is income or expense
    const isIncome = transaction.amount < 0; // Plaid uses negative for income credits

    const expenseCategories = `
- supplies: Office supplies, materials, equipment, props for content
- software: Business software, tools, subscriptions, apps
- marketing: Advertising, promotions, social media ads, brand materials
- meals: Business meals and client entertainment (50% deductible per HMRC)
- mileage: Business travel (45p/mile for first 10k miles, then 25p/mile)
- home_office: Rent, utilities, internet for home workspace (requires proportional calculation)
- professional_services: Accountant, lawyer, consultant fees
- training: Courses, books, professional development
- insurance: Business insurance premiums
- personal: Non-business expense (not deductible)`;

    const incomeCategories = `
- sponsorship_income: Sponsorships, brand deals, partnerships
- ad_revenue: YouTube, TikTok, Instagram ad revenue
- affiliate_income: Affiliate commissions, referral income
- client_fees: Client work, consulting, freelance projects
- sales_income: Product sales, merchandise, digital products
- other_income: Other business income`;

    // INCOME CATEGORIZATION
    if (isIncome) {
      const incomePrompt = `You are a UK tax expert helping a ${workTypeDesc} categorize business income under HMRC rules.

USER PROFILE:
- Work type: ${workTypeDesc}
- Monthly income: £${userProfile?.monthly_income || 'unknown'}
- Has international income: ${userProfile?.has_international_income ? 'Yes' : 'No'}

TRANSACTION (INCOME):
- Payer: ${transaction.merchant_name || transaction.name}
- Amount: £${Math.abs(transaction.amount)}
- Date: ${transaction.date}

USER'S ANSWERS TO YOUR QUESTIONS:
${JSON.stringify(answers, null, 2)}

AVAILABLE INCOME CATEGORIES:
${incomeCategories}

HMRC TAX RULES FOR INCOME:

1. **Distinguish Business Income from Personal Transfers**

   PERSONAL INCOME (NOT taxable - friends/family/gifts):
   - Friend or family paying you back for expenses
   - Personal gifts
   - Reimbursements from friends
   - Personal transfers
   → businessPercent: 0, taxDeductible: false, categoryId: "personal"

   BUSINESS INCOME (taxable):
   - Client payments, sponsorships, platform revenue, sales
   - Anything earned through self-employment
   → businessPercent: 100, taxDeductible: true, use appropriate business category

2. **Income Categories for Self Assessment:**
   - Sponsorships/brand deals → sponsorship_income
   - Ad revenue from platforms → ad_revenue
   - Affiliate commissions → affiliate_income
   - Client work/consulting → client_fees
   - Product/merchandise sales → sales_income
   - Everything else → other_income

3. **Foreign Income:**
   - If income is from outside UK, note this in explanation
   - User must declare foreign income on Self Assessment
   - May be able to claim Foreign Tax Credit Relief if tax paid abroad

4. **National Insurance:**
   - Self-employed pay Class 2 NI (if profits over £12,570/year)
   - And Class 4 NI (9% on profits £12,570-£50,270)
   - Mention in explanation if this is significant income

DECISION PROCESS:
1. Read Q1 answer - what is this income for?
2. Check for PERSONAL INCOME keywords:
   - "friend", "family", "paying me back", "paying back", "reimbursement"
   - "gift", "personal transfer", "personal", "dinner", "expense"
3. If personal keywords found → businessPercent: 0, taxDeductible: false, categoryId: "personal"
4. If business income → Read Q2 (if exists) and match to business category
5. Business income → businessPercent: 100, taxDeductible: true

EXAMPLES:

PERSONAL INCOME (NOT taxable):
Q1: "Friend paying me back for dinner last week"
→ categoryId: "personal", categoryName: "Personal Income", businessPercent: 0, taxDeductible: false, explanation: "Personal reimbursement from friend - not taxable business income"

Q1: "Friend/family paying me back"
→ categoryId: "personal", categoryName: "Personal Income", businessPercent: 0, taxDeductible: false, explanation: "Personal transfer - not business income"

Q1: "Gift or personal transfer"
→ categoryId: "personal", categoryName: "Personal Income", businessPercent: 0, taxDeductible: false, explanation: "Personal gift - not taxable"

Q1: "Personal reimbursement"
→ categoryId: "personal", categoryName: "Personal Income", businessPercent: 0, taxDeductible: false, explanation: "Personal reimbursement - not business income"

BUSINESS INCOME (taxable):
Q1: "YouTube/Google ad revenue" Q2: "Ad revenue (YouTube, TikTok, etc.)"
→ categoryId: "ad_revenue", categoryName: "Ad Revenue", businessPercent: 100, taxDeductible: true, explanation: "YouTube ad revenue - 100% taxable business income"

Q1: "Brand partnership/sponsorship" Q2: "Sponsorship or brand deal"
→ categoryId: "sponsorship_income", categoryName: "Sponsorship Income", businessPercent: 100, taxDeductible: true, explanation: "Brand sponsorship - 100% taxable business income"

Q1: "Client project payment" Q2: "Client fees or project payment"
→ categoryId: "client_fees", categoryName: "Client Fees", businessPercent: 100, taxDeductible: true, explanation: "Client payment - 100% taxable business income"

Q1: "Affiliate commission"
→ categoryId: "affiliate_income", categoryName: "Affiliate Income", businessPercent: 100, taxDeductible: true, explanation: "Affiliate commission - 100% taxable business income"

OUTPUT REQUIREMENTS:

FOR PERSONAL INCOME (friends, gifts, reimbursements):
- businessPercent: 0
- taxDeductible: false
- categoryId: "personal"
- categoryName: "Personal Income"
- Explanation: Mention it's personal/not taxable

FOR BUSINESS INCOME (earned income):
- businessPercent: 100
- taxDeductible: true
- categoryId: appropriate business category (sponsorship_income, ad_revenue, etc.)
- categoryName: friendly name
- Explanation: Mention it's taxable business income

CRITICAL VALIDATION:
1. Did user say "friend", "paying back", "gift", "personal", "reimbursement"?
   → If YES: businessPercent: 0, taxDeductible: false, categoryId: "personal"
2. Is this earned business income?
   → If YES: businessPercent: 100, taxDeductible: true, use business category

CRITICAL: Respond with ONLY valid JSON. No explanatory text. Just pure JSON starting with { and ending with }.

FOR PERSONAL INCOME:
{
  "categoryId": "personal",
  "categoryName": "Personal Income",
  "businessPercent": 0,
  "explanation": "Personal transfer/gift/reimbursement - not taxable business income",
  "taxDeductible": false
}

FOR BUSINESS INCOME:
{
  "categoryId": "one of the business income category IDs",
  "categoryName": "friendly display name (e.g., Sponsorship Income, Ad Revenue)",
  "businessPercent": 100,
  "explanation": "Brief explanation - mention it's taxable business income",
  "taxDeductible": true,
  "foreignIncome": true or false (only if from outside UK)
}`;

      const message = await anthropic.messages.create({
        model: "claude-3-5-haiku-20241022",
        max_tokens: 600,
        messages: [{ role: "user", content: incomePrompt }]
      });

      let responseText = message.content[0].text;
      console.log('🤖 AI Response:', responseText);

      responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const categorization = JSON.parse(responseText);

      console.log('✅ Categorized income as:', categorization.categoryId);
      res.json(categorization);
      return;
    }

    // EXPENSE CATEGORIZATION - Original flow
    const categories = expenseCategories;

    const prompt = `You are a UK tax expert helping a ${workTypeDesc} categorize expenses under HMRC rules.

USER PROFILE:
- Work type: ${workTypeDesc}
- Monthly income: £${userProfile?.monthly_income || 'unknown'}
- Tracking goal: ${userProfile?.tracking_goal || 'unknown'}

TRANSACTION:
- Merchant: ${transaction.merchant_name || transaction.name}
- Amount: £${Math.abs(transaction.amount)}
- Date: ${transaction.date}

USER'S ANSWERS TO YOUR QUESTIONS:
${JSON.stringify(answers, null, 2)}

NOTE: User answers may be predefined options OR free-text responses. Interpret their intent from their words.

Look for MIXED SHOPPING TRIPS - NEW ANSWER PATTERNS:

Pattern 1: "No, all personal"
→ 0% business, categoryId: "personal"

Pattern 2: "Yes - all for my [content/business/projects]"
→ 100% business, choose appropriate category (usually "supplies")

Pattern 3: "Yes - some items were" + text description with cost
- Look for the TOTAL COST of business items in their text description
- Examples: "Foundation for filming - about £45 total", "Ingredients for video - £10", "Ring light and backdrop - around £60"
- Parse the £ amount from their text (look for £, numbers, words like "about", "around", "approximately", "total")
- SPLIT the transaction into:
  * Business portion: The total £ amount they provided for business items
  * Personal portion: Total transaction amount MINUS business amount
- Return a "split" response with both portions
- In the business portion explanation, mention what items they described

Look for MILEAGE TRACKING:
- "Yes, I keep a mileage log" → Mention in explanation: "Track at 45p/mile"
- "No, but I can estimate" → Note: "Recommend starting a mileage log for HMRC"
- "I don't track it" → Warn: "IMPORTANT: Start tracking mileage - HMRC requires records"

Look for HOME OFFICE expenses:
- Rent, utilities, internet for "work from home"
- Don't track the actual expense percentage
- Note in explanation: Use HMRC simplified expenses (£6/week flat rate)

AVAILABLE CATEGORIES:
${categories}

HMRC TAX RULES YOU MUST APPLY:

1. **"Wholly and Exclusively" Rule**
   - If purchased WITH INTENT for business = 100% deductible
   - Intent at time of purchase is what matters
   - If bought for work but some used personally after = STILL 100% business expense
   - Equipment bought for business (even if sometimes personal use) = 100% deductible

2. **When to Claim 100% Business:**
   - Equipment bought for work: Laptop, phone, camera, etc. = 100% supplies (even if "sometimes" personal)
   - Content creator buys makeup FOR a specific video → 100% supplies
   - Freelancer buys equipment FOR client project → 100% supplies
   - Props, materials specifically for content → 100% supplies
   - Software/subscriptions used for business → 100% software
   - CRITICAL: If user says "for work", "for business", "sometimes for work" = 100% business

3. **NOT Deductible (Personal):**
   - Commuting to permanent workplace (even if work-related!)
   - Personal shopping, groceries, personal items
   - Personal leisure, entertainment
   - Clothing/makeup TO WEAR (even for work events/filming - this is personal grooming)
   - Meeting friends (even if discussed work)

**CRITICAL DISTINCTION for Content Creators:**
   - Makeup/clothing TO WEAR for content/events = PERSONAL (it's grooming)
   - Makeup/clothing TO REVIEW or FEATURE in video = BUSINESS (it's inventory/props)
   - "To wear for work events" = Personal
   - "To review in a video" = Business

4. **When Splitting is REQUIRED by HMRC:**
   - Home office: Must calculate % of home used for business
   - Vehicle: Track business miles vs total miles
   - Phone/internet CONTRACTS (ongoing): If genuinely mixed use, track % business use

**When Splitting is NOT allowed:**
   - Equipment purchases (laptop, phone, camera, etc.) - these are 100% if bought for business
   - One-time equipment = 100% business (don't split)

5. **Special Rules:**
   - Business meals: Max 50% deductible (HMRC rule)
   - Mileage: Use 45p/mile (first 10k miles) instead of actual costs
   - Gifts to clients: Max £50/person/year

DECISION PROCESS:
1. Read the user's answer carefully - what did they actually say?
2. FIRST: Determine if this is CAPITAL EQUIPMENT or ONGOING EXPENSE:
   - Capital equipment (one-time): Phone device, laptop, camera, desk, software license
   - Ongoing expense (recurring): Phone bill, internet bill, utilities, subscriptions
   - Clues: Amount (£200+ = likely device), Merchant (Apple Store = device, EE Mobile = bill), Plaid category
3. For CAPITAL EQUIPMENT:
   - If used for business (even "sometimes") → 100% business
   - Keywords: "for work", "sometimes for work", "use for business" = 100%
4. For ONGOING EXPENSES:
   - If "sometimes for work" → ask for % or estimate split
   - If "mostly for work" → 70-80% business
   - If "all for work" → 100% business
5. Did they say it's for commuting or purely personal? → 0% personal
6. When uncertain, be conservative - don't assume business use

EXAMPLES OF INTERPRETATION:

SIMPLE CASES:
- "I bought this bike for commuting to my office" → Personal (commuting NOT deductible)
- "I bought this bike for delivery work" → Business supplies (100%)
- "Quick coffee on my own" → Personal
- "Business meeting with client" → Business meals (50%)
- "Camera for filming my content" → Business supplies (100%)
- "Makeup to wear for work events/filming" → Personal (grooming - NOT deductible)
- "Makeup to review or feature in a video" → Business supplies (100%)
- "Foundation for everyday personal use" → Personal

HOME OFFICE CASES (AUTOMATIC - NO PERCENTAGE):
- Q: "Rent" A: "I work from home"
  → businessPercent: 0, categoryId: "personal", explanation: "For home office expenses, use HMRC's simplified expenses scheme (£6/week flat rate) instead of claiming rent. This is easier and doesn't require calculations."

- Q: "Internet bill" A: "For work from home"
  → businessPercent: 100, categoryId: "home_office", explanation: "Business internet for home office - 100% deductible"

- Q: "Utilities" A: "I work from home"
  → businessPercent: 0, categoryId: "personal", explanation: "For utilities when working from home, use HMRC's simplified expenses (£6/week) instead. Claim this weekly allowance rather than actual costs."

MILEAGE CASES:
- Q: "Bike" A: "Delivery/business travel"
  Q: "Do you track mileage?" A: "Yes, I keep a mileage log"
  → businessPercent: 100, categoryId: "mileage", explanation: "Business travel - Track at 45p/mile for first 10k miles"

- Q: "Bike" A: "Delivery work"
  Q: "Do you track mileage?" A: "I don't track it"
  → businessPercent: 100, categoryId: "mileage", explanation: "Business travel - IMPORTANT: Start tracking mileage (HMRC requires records)"

EQUIPMENT PURCHASES (100% BUSINESS):
- Transaction: Apple Store £500, Q: "Phone" A: "Sometimes for work, sometimes personal"
  → businessPercent: 100, categoryId: "supplies", explanation: "Phone device for business - 100% deductible under capital allowances"

- Transaction: Currys £800, Q: "Laptop" A: "For work and some personal use"
  → businessPercent: 100, categoryId: "supplies", explanation: "Laptop for business - 100% deductible under HMRC 'wholly and exclusively' rule"

- Transaction: Amazon £200, Q: "Camera" A: "To film content"
  → businessPercent: 100, categoryId: "supplies", explanation: "Business equipment for content creation"

ONGOING BILLS (SPLIT BY USAGE):
- Transaction: EE Mobile £35, Q: "Phone bill" A: "Sometimes for work"
  → businessPercent: 50, categoryId: "supplies", explanation: "Phone contract - 50% business use estimate"

- Transaction: Sky Broadband £40, Q: "Internet" A: "Use for work"
  → businessPercent: 100, categoryId: "home_office", explanation: "Internet for business - 100% deductible"

CRITICAL:
- DEVICE PURCHASES (capital) = 100% if used for business
- MONTHLY BILLS (ongoing) = split by actual usage %

MIXED SHOPPING CASES:

Case 1 - All personal:
- Transaction: Tesco £45
  Q1: "What did you buy?" A: "Weekly food shop"
  Q2: "Did you buy anything you'll review/feature in your content?" A: "No, all personal"
  → REGULAR RESPONSE:
  {
    "categoryId": "personal",
    "categoryName": "Personal",
    "businessPercent": 0,
    "explanation": "Weekly groceries - personal expense",
    "taxDeductible": false
  }

Case 2 - All business:
- Transaction: Tesco £45
  Q1: "What did you buy?" A: "Ingredients"
  Q2: "Did you buy anything you'll review/feature in your content?" A: "Yes - all for my content"
  → REGULAR RESPONSE:
  {
    "categoryId": "supplies",
    "categoryName": "Business Supplies",
    "businessPercent": 100,
    "explanation": "Ingredients for content creation - 100% business expense",
    "taxDeductible": true
  }

Case 3 - Split transaction:
- Transaction: Tesco £45
  Q1: "What did you buy?" A: "Weekly food shop"
  Q2: "Did you buy anything you'll review/feature in your content?" A: "Yes - some items were"
  Q3: "What did you buy for your content and approximately how much?" A: "Foundation for filming and ring light - about £20 total"
  → SPLIT RESPONSE:
  {
    "isSplit": true,
    "splits": [
      {
        "amount": 20,
        "categoryId": "supplies",
        "categoryName": "Business Supplies",
        "businessPercent": 100,
        "explanation": "Foundation for filming and ring light - content creation supplies",
        "taxDeductible": true,
        "description": "Foundation and ring light for content"
      },
      {
        "amount": 25,
        "categoryId": "personal",
        "categoryName": "Personal",
        "businessPercent": 0,
        "explanation": "Remaining groceries - personal expense",
        "taxDeductible": false,
        "description": "Personal groceries"
      }
    ]
  }

OUTPUT REQUIREMENTS:
- Extract businessPercent from percentage answers (e.g., "Mostly business (60-80%)" → 70)
- If 100% business intent → businessPercent: 100, taxDeductible: true
- If split use (e.g., 70% business) → businessPercent: 70, taxDeductible: true (tax deductible for the business portion)
- If 0% business → businessPercent: 0, categoryId: "personal", taxDeductible: false
- Choose the MOST SPECIFIC category that fits
- Explanation should:
  * Mention the percentage if split
  * Reference HMRC rules if relevant (mileage, gifted items, etc.)
  * Include warnings (e.g., "start tracking mileage")
- Be conservative - when uncertain, default to personal

FOR MIXED SHOPPING TRIPS:
- If user provided estimated cost for business items (e.g., "Foundation - £15")
- Parse the £ amount (look for £, numbers, "about", "around", "approximately")
- Return a SPLIT RESPONSE with isSplit: true
- Business amount = what they estimated
- Personal amount = total transaction - business amount
- Each split must have: amount, categoryId, categoryName, businessPercent, explanation, taxDeductible, description

CRITICAL: Respond with ONLY valid JSON. No explanatory text. No commentary. Just pure JSON starting with { and ending with }.

FOR SINGLE-PURPOSE TRANSACTIONS:
{
  "categoryId": "one of the category IDs above",
  "categoryName": "friendly display name",
  "businessPercent": 0-100 (exact number based on their answer),
  "explanation": "Explanation including percentage, HMRC rules, and any warnings",
  "taxDeductible": true or false (true if businessPercent > 0),
  "additionalNotes": "Optional field for gifted item notes or mileage warnings"
}

FOR SPLIT TRANSACTIONS (mixed shopping with business items):
{
  "isSplit": true,
  "splits": [
    {
      "amount": business_amount_in_pounds,
      "categoryId": "supplies or appropriate category",
      "categoryName": "Business Supplies",
      "businessPercent": 100,
      "explanation": "What the business items were and why they're deductible",
      "taxDeductible": true,
      "description": "Short description of business items"
    },
    {
      "amount": remaining_amount,
      "categoryId": "personal",
      "categoryName": "Personal",
      "businessPercent": 0,
      "explanation": "Remaining items - personal expense",
      "taxDeductible": false,
      "description": "Remaining personal items"
    }
  ]
}`;


    const message = await anthropic.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }]
    });

    let responseText = message.content[0].text;
    console.log('🤖 AI Response:', responseText);

    // Strip markdown code blocks if present
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    const categorization = JSON.parse(responseText);

    console.log('✅ Categorized as:', categorization.categoryId, `(${categorization.businessPercent}%)`);
    res.json(categorization);
  } catch (error) {
    console.error('❌ Error categorizing:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk categorize all transactions at once
app.post('/api/bulk_categorize', async (req, res) => {
  try {
    const { transactions, userProfile, userId } = req.body;
    console.log('⚡ Bulk categorizing', transactions.length, 'transactions for user:', userId);

    if (!transactions || !transactions.length) {
      return res.status(400).json({ success: false, error: 'No transactions provided' });
    }

    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID is required' });
    }

    const workTypeDesc = userProfile?.work_type === 'content_creation' ? 'content creator'
      : userProfile?.work_type === 'freelancing' ? 'freelancer'
      : userProfile?.work_type === 'side_hustle' ? 'side hustler'
      : userProfile?.custom_work_type || 'self-employed';

    const categories = `
- supplies: Office supplies, materials, equipment, props for content
- software: Business software, tools, subscriptions, apps
- marketing: Advertising, promotions, social media ads, brand materials
- meals: Business meals and client entertainment (50% deductible per HMRC)
- mileage: Business travel (45p/mile for first 10k miles, then 25p/mile)
- home_office: Rent, utilities, internet for home workspace
- professional_services: Accountant, lawyer, consultant fees
- training: Courses, books, professional development
- insurance: Business insurance premiums
- personal: Non-business expense (not deductible)`;

    let categorizedCount = 0;
    const results = [];

    // Process each transaction
    for (const transaction of transactions) {
      try {
        console.log(`  📝 Categorizing: ${transaction.merchant_name || transaction.name}`);

        // Build AI prompt for automatic categorization
        const prompt = `You are a UK tax expert helping a ${workTypeDesc} categorize expenses under HMRC rules.

USER PROFILE:
- Work type: ${workTypeDesc}
- Monthly income: £${userProfile?.monthly_income || 'unknown'}
- Tracking goal: ${userProfile?.tracking_goal || 'unknown'}

TRANSACTION TO CATEGORIZE:
- Merchant: ${transaction.merchant_name || transaction.name}
- Amount: £${Math.abs(transaction.amount)}
- Date: ${transaction.date}
- Plaid Category: ${transaction.category?.join(', ') || 'Unknown'}

AVAILABLE CATEGORIES:
${categories}

TASK: Automatically categorize this transaction based on common business use patterns.

HMRC RULES:
1. Business expenses must be "wholly and exclusively" for business
2. Common business expenses for ${workTypeDesc}:
   - Equipment, software, materials = 100% supplies/software
   - Professional services = 100% professional_services
   - Business meals = 50% meals
   - Clearly personal items = personal

DECISION LOGIC:
- If likely business-related (equipment, software, services) → Mark as business expense
- If clearly personal (groceries, personal shopping) → Mark as personal
- When uncertain, prefer business if it's a common expense for this work type

Respond with ONLY valid JSON:
{
  "categoryId": "one of the category IDs above",
  "categoryName": "friendly display name",
  "businessPercent": 0-100,
  "explanation": "Brief explanation (1 sentence)",
  "taxDeductible": true or false
}`;

        // Call AI to categorize
        const message = await anthropic.messages.create({
          model: "claude-3-5-haiku-20241022",
          max_tokens: 600,
          messages: [{ role: "user", content: prompt }]
        });

        let responseText = message.content[0].text;
        responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const categorization = JSON.parse(responseText);

        // Save to Supabase using admin client (bypasses RLS for server-side operations)
        const { error } = await supabaseAdmin
          .from('categorized_transactions')
          .upsert({
            user_id: userId,
            plaid_transaction_id: transaction.transaction_id,
            merchant_name: transaction.merchant_name || transaction.name,
            amount: Math.abs(transaction.amount),
            transaction_date: transaction.date,
            plaid_category: transaction.category || [],
            category_id: categorization.categoryId,
            category_name: categorization.categoryName,
            business_percent: categorization.businessPercent,
            explanation: categorization.explanation,
            tax_deductible: categorization.taxDeductible,
            user_answers: {}, // Empty for bulk categorization
          }, {
            onConflict: 'user_id,plaid_transaction_id'
          });

        if (error) {
          console.error(`  ❌ Error saving ${transaction.name}:`, error);
          results.push({
            transaction_id: transaction.transaction_id,
            success: false,
            error: error.message
          });
        } else {
          console.log(`  ✅ Saved: ${categorization.categoryName} (${categorization.businessPercent}%)`);
          categorizedCount++;
          results.push({
            transaction_id: transaction.transaction_id,
            success: true,
            category: categorization.categoryName
          });
        }

      } catch (error) {
        console.error(`  ❌ Error processing ${transaction.name}:`, error);
        results.push({
          transaction_id: transaction.transaction_id,
          success: false,
          error: error.message
        });
      }
    }

    console.log(`✅ Bulk categorization complete: ${categorizedCount}/${transactions.length} successful`);

    res.json({
      success: true,
      categorizedCount,
      total: transactions.length,
      results
    });
  } catch (error) {
    console.error('❌ Error in bulk categorization:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Re-categorize transaction based on user feedback
app.post('/api/recategorize_with_feedback', async (req, res) => {
  try {
    const { transaction, answers, userProfile, currentCategorization, feedback } = req.body;
    console.log('🔄 Re-categorizing with feedback:', transaction.name);
    console.log('💬 User feedback:', feedback);
    console.log('📊 Current categorization:', currentCategorization);

    const workTypeDesc = userProfile?.work_type === 'content_creation' ? 'content creator'
      : userProfile?.work_type === 'freelancing' ? 'freelancer'
      : userProfile?.work_type === 'side_hustle' ? 'side hustler'
      : userProfile?.custom_work_type || 'self-employed';

    const categories = `
- supplies: Office supplies, materials, equipment, props for content
- software: Business software, tools, subscriptions, apps
- marketing: Advertising, promotions, social media ads, brand materials
- meals: Business meals and client entertainment (50% deductible per HMRC)
- mileage: Business travel (45p/mile for first 10k miles, then 25p/mile)
- home_office: Rent, utilities, internet for home workspace (requires proportional calculation)
- professional_services: Accountant, lawyer, consultant fees
- training: Courses, books, professional development
- insurance: Business insurance premiums
- personal: Non-business expense (not deductible)`;

    const prompt = `You are a UK tax expert helping a ${workTypeDesc} categorize expenses under HMRC rules.

USER PROFILE:
- Work type: ${workTypeDesc}
- Monthly income: £${userProfile?.monthly_income || 'unknown'}
- Tracking goal: ${userProfile?.tracking_goal || 'unknown'}

TRANSACTION:
- Merchant: ${transaction.merchant_name || transaction.name}
- Amount: £${Math.abs(transaction.amount)}
- Date: ${transaction.date}

USER'S ORIGINAL ANSWERS:
${JSON.stringify(answers, null, 2)}

CURRENT CATEGORIZATION (what we showed them):
${JSON.stringify(currentCategorization, null, 2)}

USER'S FEEDBACK (what they said is wrong):
"${feedback}"

YOUR TASK: Re-categorize this transaction based on the user's feedback.

AVAILABLE CATEGORIES:
${categories}

INSTRUCTIONS:
1. Read the user's feedback carefully
2. Understand what they think should change
3. Apply HMRC rules correctly based on their correction
4. Return a NEW categorization that addresses their concerns

Common feedback patterns:
- "This should be 100% business" → Change to businessPercent: 100, taxDeductible: true
- "This is personal" → Change to businessPercent: 0, categoryId: "personal", taxDeductible: false
- "Wrong category" → Change categoryId and categoryName to match their description
- "Should be split" → Create a split transaction if they describe business vs personal portions
- "Percentage is wrong" → Adjust businessPercent to match what they indicate

HMRC RULES:
1. "Wholly and exclusively" rule - if bought WITH INTENT for business = 100% deductible
2. Business meals: Max 50% deductible
3. Commuting to permanent workplace: NOT deductible (even if work-related)
4. Equipment bought for business: 100% deductible even if some personal use

Be responsive to their feedback while ensuring HMRC compliance.

CRITICAL: Respond with ONLY valid JSON. No explanatory text. No commentary. Just pure JSON starting with { and ending with }.

FOR SINGLE-PURPOSE TRANSACTIONS:
{
  "categoryId": "one of the category IDs above",
  "categoryName": "friendly display name",
  "businessPercent": 0-100 (exact number based on feedback),
  "explanation": "Updated explanation acknowledging their feedback",
  "taxDeductible": true or false
}

FOR SPLIT TRANSACTIONS (if feedback indicates splitting):
{
  "isSplit": true,
  "splits": [
    {
      "amount": business_amount_in_pounds,
      "categoryId": "supplies or appropriate category",
      "categoryName": "Business Supplies",
      "businessPercent": 100,
      "explanation": "What the business items were",
      "taxDeductible": true,
      "description": "Short description of business items"
    },
    {
      "amount": remaining_amount,
      "categoryId": "personal",
      "categoryName": "Personal",
      "businessPercent": 0,
      "explanation": "Personal portion",
      "taxDeductible": false,
      "description": "Personal items"
    }
  ]
}`;

    const message = await anthropic.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }]
    });

    let responseText = message.content[0].text;
    console.log('🤖 AI Response:', responseText);

    // Strip markdown code blocks if present
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    const newCategorization = JSON.parse(responseText);

    // FIX: For income splits, ensure business income has taxDeductible: true
    const isIncome = transaction.amount < 0; // Negative = income in Plaid
    if (isIncome && newCategorization.isSplit && newCategorization.splits) {
      newCategorization.splits = newCategorization.splits.map(split => ({
        ...split,
        // Business income (businessPercent > 0) should be taxDeductible: true
        // Personal income (businessPercent === 0) should be taxDeductible: false
        taxDeductible: split.businessPercent > 0
      }));
      console.log('✅ Fixed taxDeductible for income splits');
    }

    console.log('✅ Re-categorized as:', newCategorization.categoryId || 'split', `(${newCategorization.businessPercent || 'split'}%)`);
    res.json(newCategorization);
  } catch (error) {
    console.error('❌ Error re-categorizing with feedback:', error);
    res.status(500).json({ error: error.message });
  }
});

// Separate function - easy to iterate on prompts
function buildCategorizationPrompt(transaction, userProfile, userAnswers) {
  return `You are a tax categorization assistant for UK content creators.

USER PROFILE:
- Content type: ${userProfile.contentType}
- Products featured: ${userProfile.typicalProducts}
- Creation methods: ${userProfile.creationMethod?.join(', ')}
- Tools used: ${userProfile.toolsUsed?.join(', ')}
- Business structure: ${userProfile.businessStructure}

TRANSACTION:
- Merchant: ${transaction.merchant_name || transaction.name}
- Amount: £${Math.abs(transaction.amount)}
- Date: ${transaction.date}
- Category: ${transaction.category?.join(', ')}

USER ANSWERS TO QUESTIONS:
${JSON.stringify(userAnswers, null, 2)}

Categorize this expense for UK tax purposes. Consider:
- Is this ordinary and wholly for the business?
- What percentage is business vs personal use?
- What HMRC category does it fall under?

Respond with ONLY valid JSON (no markdown, no explanations):
{
  "category": "HMRC category name (e.g., Travel, Equipment, Supplies)",
  "businessPercent": 0-100,
  "reasoning": "Brief explanation of why this categorization",
  "isDeductible": true or false
}`;
}

// NEW: Generate personalized onboarding guide
app.post('/api/generate-guide', async (req, res) => {
  try {
    const {
      workType,
      timeCommitment,
      monthlyIncome,
      receivesGiftedItems,
      hasInternationalIncome,
      trackingGoal,
    } = req.body;

    console.log('📝 RAW INPUT - trackingGoal:', trackingGoal);
    console.log('📝 RAW INPUT - hasInternationalIncome:', hasInternationalIncome);
    console.log('📝 RAW INPUT - receivesGiftedItems:', receivesGiftedItems);

    // Validate required fields
    if (!workType || !timeCommitment || monthlyIncome === undefined) {
      return res.status(400).json({ 
        error: 'Missing required fields' 
      });
    }

    const incomeRange = 
      monthlyIncome < 500 ? 'under £500'
      : monthlyIncome < 2000 ? '£500-£2,000'
      : monthlyIncome < 5000 ? '£2,000-£5,000'
      : 'over £5,000';

    // trackingGoal now directly contains the business structure
    const businessStructure = trackingGoal;

    console.log('📋 Business structure from trackingGoal:', businessStructure);

    // Build guide sections manually for clarity
    let guide = `## 📋 Your Tax Situation\n\n`;
    
    if (businessStructure === 'limited_company') {
      guide += `You've got a limited company! That means:\n\n`;
      guide += `**Your company** pays Corporation Tax on profits\n\n`;
      guide += `**You personally** file Self Assessment on salary/dividends\n\n`;
      guide += `Don't worry - bopp helps you track everything you need for your personal side.\n\n`;
    } else if (businessStructure === 'sole_trader') {
      guide += `As a sole trader, you file **one tax return** each year.\n\n`;
      guide += `Deadline: 31st January\n\n`;
    } else {
      guide += `**First things first:** Register with HMRC for Self Assessment\n\n`;
      guide += `You need this if you earn over £1,000/year\n\n`;
      guide += `Once registered, bopp will help you track everything!\n\n`;
    }

    guide += `## 💰 What You Can Claim\n\n`;
    guide += `Basically anything you buy **specifically** for your ${workType === 'content_creation' ? 'content' : 'business'}:\n\n`;
    guide += `🎥 Equipment\n\n`;
    guide += `💻 Software\n\n`;
    guide += `🏠 Part of rent/bills (home office)\n\n`;
    guide += `🚗 Work travel\n\n`;

    if (receivesGiftedItems) {
      guide += `## 🎁 Gifted Items\n\n`;
      guide += `When brands send you free stuff, it counts as income.\n\n`;
      guide += `**But** you can usually claim it back as an expense if you use it in content.\n\n`;
      guide += `Net result? No tax to pay on it.\n\n`;
    }

    if (hasInternationalIncome) {
      guide += `## 🌍 International Money\n\n`;
      guide += `Declare all income from overseas brands to HMRC.\n\n`;
      guide += `You can get tax relief to avoid paying twice.\n\n`;
    }

    guide += `## ✅ What To Do Now\n\n`;
    
    if (businessStructure === 'not_registered') {
      guide += `1. Register at gov.uk/register-for-self-assessment\n\n`;
      guide += `2. Connect your bank to bopp\n\n`;
      guide += `3. Let us do the heavy lifting!\n\n`;
    } else {
      guide += `Connect your bank and start tracking.\n\n`;
      guide += `bopp will categorize everything and keep you organized.\n\n`;
    }

    guide += `💡 **Pro tip:** Set aside 25-30% of income for tax\n\n`;

    guide += `---\n\n`;
    guide += `*This is general guidance only. For specific advice about your situation, speak to a qualified accountant.*`;

    console.log('✅ Guide constructed');
    console.log('📄 Business structure:', businessStructure);
    
    res.json({ guide });
  } catch (error) {
    console.error('❌ Error generating guide:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Listen on all network interfaces
app.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on http://${HOST}:${PORT}`);
  console.log(`🔧 Plaid environment: ${process.env.PLAID_ENV}`);
  console.log(`🤖 AI categorization: ${process.env.ANTHROPIC_API_KEY ? 'enabled' : 'disabled'}`);
  console.log(`💾 Supabase: ${process.env.SUPABASE_URL ? 'connected' : 'not configured'}`);
});