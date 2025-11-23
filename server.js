const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const Anthropic = require('@anthropic-ai/sdk');
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

// Create link token
app.post('/api/create_link_token', async (req, res) => {
  try {
    const { userId } = req.body;
    console.log('📥 Creating link token for user:', userId);
    
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: 'Bopp',
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

// Sync transactions from Plaid
app.post('/api/sync_transactions', async (req, res) => {
  try {
    const { access_token } = req.body;
    console.log('📊 Syncing transactions...');
    
    // Get last 30 days of transactions
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);
    const endDate = new Date();
    
    const response = await plaidClient.transactionsGet({
      access_token: access_token,
      start_date: startDate.toISOString().split('T')[0],
      end_date: endDate.toISOString().split('T')[0],
    });

    console.log(`✅ Found ${response.data.transactions.length} transactions`);
    res.json({ 
      transactions: response.data.transactions,
      count: response.data.transactions.length
    });
  } catch (error) {
    console.error('❌ Error syncing transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Categorize transaction with AI
app.post('/api/categorize_transaction', async (req, res) => {
  try {
    const { transaction, userProfile, userAnswers } = req.body;
    console.log('🤖 Categorizing transaction:', transaction.name);
    
    // Build prompt dynamically - EASY TO CHANGE LATER
    const prompt = buildCategorizationPrompt(transaction, userProfile, userAnswers);
    
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: prompt
      }]
    });
    
    const responseText = message.content[0].text;
    console.log('AI Response:', responseText);
    
    // Parse JSON response
    const categorization = JSON.parse(responseText);
    
    console.log('✅ Categorized as:', categorization.category, `(${categorization.businessPercent}%)`);
    res.json(categorization);
  } catch (error) {
    console.error('❌ Error categorizing:', error);
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

    console.log('📝 Generating guide - Structure:', trackingGoal, 'International:', hasInternationalIncome);

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

    // Map trackingGoal to clear business structure
    const businessStructure = 
      trackingGoal === 'compliance' ? 'sole_trader'
      : trackingGoal === 'deductions' ? 'limited_company'
      : 'not_registered';

    console.log('📋 Mapped business structure:', businessStructure);

    const prompt = `You are a UK tax advisor. Generate a personalized tax guide for a content creator.

USER DATA:
- Work type: ${workType}
- Time commitment: ${timeCommitment}
- Monthly income: ${incomeRange} (£${monthlyIncome})
- Receives gifted items: ${receivesGiftedItems}
- Has international income: ${hasInternationalIncome}
- Business structure: ${businessStructure}

MANDATORY RULES - YOU MUST FOLLOW THESE EXACTLY:

1. TAX OBLIGATIONS SECTION (## Your Tax Status):
   
   IF business_structure = "limited_company":
   - MUST say: "As a limited company director, you have TWO separate tax obligations:"
   - MUST explain: Company files Corporation Tax (CT600) - usually due 9 months after year-end
   - MUST explain: You personally file Self Assessment as a director
   - DO NOT tell them to "register" - they already are registered
   
   IF business_structure = "sole_trader":
   - MUST say: "You're registered as a sole trader"
   - MUST explain: File annual Self Assessment returns
   - MUST explain: Pay Income Tax and National Insurance on profits
   - DO NOT tell them to "register" - they already are registered
   
   IF business_structure = "not_registered":
   - MUST say: "You need to register with HMRC for Self Assessment"
   - MUST explain: Required if earning over £1,000/year from self-employment
   - MUST explain: Deadline is 5th October after your first tax year ends

2. EXPENSES SECTION (## What You Can Claim):
   - MUST mention: Equipment, software, home office costs, travel for content
   
3. IF receivesGiftedItems = true:
   - MUST include section explaining gifted items count as taxable income at retail value
   - MUST explain they can often claim them back as business expenses if used for content

4. IF hasInternationalIncome = true:
   - MUST include section about international income
   - MUST explain: All worldwide income must be declared to HMRC
   - MUST mention: Possible relief for foreign taxes to avoid double taxation

5. NEXT STEPS SECTION (## Your Next Step):
   - Give ONE clear actionable step based on their situation

FORMAT:
Use markdown headers (##) for sections. Keep total length under 250 words. Be friendly and clear.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const guide = message.content[0].text;
    
    console.log('✅ Guide generated');
    console.log('📄 Guide preview:', guide.substring(0, 200));
    
    res.json({ guide });
  } catch (error) {
    console.error('❌ Error generating guide:', error);
    
    // Structured fallback based on business structure
    const businessStructure = 
      req.body.trackingGoal === 'compliance' ? 'sole_trader'
      : req.body.trackingGoal === 'deductions' ? 'limited_company'
      : 'not_registered';
    
    let fallbackGuide = `# Your Tax Quick Guide\n\n`;
    
    // Tax status section
    fallbackGuide += `## Your Tax Status\n\n`;
    
    if (businessStructure === 'limited_company') {
      fallbackGuide += `As a limited company director, you have **TWO separate tax obligations**:\n\n`;
      fallbackGuide += `• **Company**: Files Corporation Tax (CT600) - usually due 9 months after year-end\n`;
      fallbackGuide += `• **You personally**: File Self Assessment as a director\n\n`;
    } else if (businessStructure === 'sole_trader') {
      fallbackGuide += `You're registered as a sole trader:\n\n`;
      fallbackGuide += `• File annual Self Assessment returns\n`;
      fallbackGuide += `• Pay Income Tax and National Insurance on profits\n\n`;
    } else {
      fallbackGuide += `You need to register with HMRC for Self Assessment:\n\n`;
      fallbackGuide += `• Required if earning over £1,000/year\n`;
      fallbackGuide += `• Deadline: 5th October after your first tax year ends\n\n`;
    }
    
    // Expenses section
    fallbackGuide += `## What You Can Claim\n\n`;
    fallbackGuide += `• Business expenses: equipment, software, home office costs, travel for content\n`;
    
    // Gifted items
    if (req.body.receivesGiftedItems) {
      fallbackGuide += `• **Gifted items**: Count as income at retail value, BUT you can often claim them back as business expenses if used for content\n`;
    }
    
    fallbackGuide += `\n`;
    
    // International income
    if (req.body.hasInternationalIncome) {
      fallbackGuide += `## International Income\n\n`;
      fallbackGuide += `• All worldwide income must be declared to HMRC\n`;
      fallbackGuide += `• You might get relief for foreign taxes paid to avoid double taxation\n\n`;
    }
    
    // Next steps
    fallbackGuide += `## Your Next Step\n\n`;
    if (businessStructure === 'not_registered') {
      fallbackGuide += `Register with HMRC as self-employed immediately. Set aside 25-30% of income for tax and start tracking expenses now.\n\n`;
    } else {
      fallbackGuide += `Start tracking ALL expenses now. Proper records from the start will save you headaches at tax time.\n\n`;
    }
    
    fallbackGuide += `You've got this!`;
    
    console.log('📋 Using fallback guide for:', businessStructure);
    res.json({ guide: fallbackGuide });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔧 Plaid environment: ${process.env.PLAID_ENV}`);
  console.log(`🤖 AI categorization: ${process.env.ANTHROPIC_API_KEY ? 'enabled' : 'disabled'}`);
});