const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔧 Plaid environment: ${process.env.PLAID_ENV}`);
});