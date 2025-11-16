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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔧 Plaid environment: ${process.env.PLAID_ENV}`);
  console.log(`🤖 AI categorization: ${process.env.ANTHROPIC_API_KEY ? 'enabled' : 'disabled'}`);
});
