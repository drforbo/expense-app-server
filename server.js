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
    const { access_token, useMockData = true } = req.body;
    console.log('📊 Syncing transactions...');

    let allTransactions = [];

    // For testing: Always use mock data for consistent IDs
    if (useMockData) {
      console.log('🧪 Using mock data for testing (consistent transaction IDs)...');

      const today = new Date();
      const mockTransactions = [
        {
          transaction_id: 'mock-1',
          name: 'Boots',
          merchant_name: 'Boots',
          amount: 24.99,
          date: new Date(today.setDate(today.getDate() - 2)).toISOString().split('T')[0],
          category: ['Shops', 'Health and Beauty']
        },
        {
          transaction_id: 'mock-2',
          name: 'Tesco',
          merchant_name: 'Tesco',
          amount: 45.20,
          date: new Date(today.setDate(today.getDate() - 5)).toISOString().split('T')[0],
          category: ['Food and Drink', 'Groceries']
        },
        {
          transaction_id: 'mock-3',
          name: 'Amazon',
          merchant_name: 'Amazon',
          amount: 89.99,
          date: new Date(today.setDate(today.getDate() - 7)).toISOString().split('T')[0],
          category: ['Shops', 'Digital Purchase']
        },
        {
          transaction_id: 'mock-4',
          name: 'Starbucks',
          merchant_name: 'Starbucks',
          amount: 4.50,
          date: new Date(today.setDate(today.getDate() - 1)).toISOString().split('T')[0],
          category: ['Food and Drink', 'Restaurants', 'Coffee Shop']
        },
        {
          transaction_id: 'mock-5',
          name: 'Shell',
          merchant_name: 'Shell',
          amount: 52.00,
          date: new Date(today.setDate(today.getDate() - 3)).toISOString().split('T')[0],
          category: ['Travel', 'Gas Stations']
        },
        {
          transaction_id: 'mock-6',
          name: 'Currys',
          merchant_name: 'Currys',
          amount: 299.99,
          date: new Date(today.setDate(today.getDate() - 10)).toISOString().split('T')[0],
          category: ['Shops', 'Electronics']
        }
      ];

      allTransactions = mockTransactions;
      console.log('✅ Using 6 mock transactions');
    } else {
      // Use real Plaid data
      console.log('🔄 Fetching real Plaid transactions...');

      let hasMore = true;
      let cursor = null;

      while (hasMore) {
        const request = {
          access_token: access_token,
        };

        if (cursor) {
          request.cursor = cursor;
        }

        const response = await plaidClient.transactionsSync(request);

        const { added, modified, removed, next_cursor, has_more } = response.data;

        allTransactions = allTransactions.concat(added);
        hasMore = has_more;
        cursor = next_cursor;

        console.log(`📥 Batch: ${added.length} added, ${modified.length} modified, ${removed.length} removed`);
      }

      console.log(`✅ Total found from Plaid: ${allTransactions.length} transactions`);

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
            date: new Date(today.setDate(today.getDate() - 2)).toISOString().split('T')[0],
            category: ['Shops', 'Health and Beauty']
          },
          {
            transaction_id: 'mock-2',
            name: 'Tesco',
            merchant_name: 'Tesco',
            amount: 45.20,
            date: new Date(today.setDate(today.getDate() - 5)).toISOString().split('T')[0],
            category: ['Food and Drink', 'Groceries']
          },
          {
            transaction_id: 'mock-3',
            name: 'Amazon',
            merchant_name: 'Amazon',
            amount: 89.99,
            date: new Date(today.setDate(today.getDate() - 7)).toISOString().split('T')[0],
            category: ['Shops', 'Digital Purchase']
          },
          {
            transaction_id: 'mock-4',
            name: 'Starbucks',
            merchant_name: 'Starbucks',
            amount: 4.50,
            date: new Date(today.setDate(today.getDate() - 1)).toISOString().split('T')[0],
            category: ['Food and Drink', 'Restaurants', 'Coffee Shop']
          },
          {
            transaction_id: 'mock-5',
            name: 'Shell',
            merchant_name: 'Shell',
            amount: 52.00,
            date: new Date(today.setDate(today.getDate() - 3)).toISOString().split('T')[0],
            category: ['Travel', 'Gas Stations']
          },
          {
            transaction_id: 'mock-6',
            name: 'Currys',
            merchant_name: 'Currys',
            amount: 299.99,
            date: new Date(today.setDate(today.getDate() - 10)).toISOString().split('T')[0],
            category: ['Shops', 'Electronics']
          }
        ];

        allTransactions = mockTransactions;
        console.log('✅ Using 6 mock transactions');
      }
    }

    // Sort by date descending (newest first)
    const sortedTransactions = allTransactions.sort((a, b) =>
      new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    res.json({
      transactions: sortedTransactions,
      count: sortedTransactions.length
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

    // Check how many questions have been answered
    const numAnswered = Object.keys(previousAnswers).length;
    const hasPreviousAnswers = numAnswered > 0;

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

YOUR GOAL: Generate Q2 based on whether Q1 was a SINGLE PRODUCT or MULTIPLE PRODUCTS.

STEP 1: Analyze Q1 answer - is it single or multiple products?

SINGLE PRODUCT examples:
- "Foundation", "Makeup", "Laptop", "Camera", "Phone", "Bike", "Coffee", "Ring light"
- Specific named items

MULTIPLE PRODUCTS examples:
- "Weekly food shop", "Big shop", "Groceries", "Various items", "Shopping", "Multiple things"
- Any answer suggesting they bought MANY different items in one trip

STEP 2: Generate Q2 based on type:

IF SINGLE PRODUCT:
Q2: "What is this [item] for?"
- Ask about the specific item's purpose
- Include HMRC-accurate scenarios
- Make it personal AND business options

Example - Q1="Foundation":
Q2: "What is this foundation for?"
- "To review or feature in a video" (100% business)
- "To wear for work events/filming" (personal - HMRC says personal grooming)
- "Everyday personal use" (personal)
- "As props for set dressing" (100% business)

Example - Q1="Laptop":
Q2: "What will you use this laptop for?"
- "Personal use and entertainment" (personal)
- "Exclusively for editing videos/content" (100% business)
- "Work and some personal use" (100% business if bought for business)
- "Running my business" (100% business)

IF MULTIPLE PRODUCTS (shopping trip):
Q2: Ask if ANY were for their business (use friendly, personalized language based on work type)

For content_creation: "Did you buy anything you'll review, feature, or use in your content?"
For freelancing: "Did you buy anything you'll use for client work or projects?"
For side_hustle: "Did you buy anything for your side hustle?"
For general: "Did you buy anything for your business?"

Options (ALWAYS THE SAME 3):
- "No, all personal"
- "Yes - all for my [content/business/projects]"
- "Yes - some items were"

Example - Q1="Weekly food shop":
Q2: "Did you buy anything you'll review, feature, or use in your content?"
- "No, all personal"
- "Yes - all for my content"
- "Yes - some items were"

IMPORTANT:
- Detect if it's single vs multiple from their Q1 answer
- For single items: ask about purpose/use
- For multiple items: ask if ANY were for business (friendly language)
- Make it easy to admit personal

Respond with ONLY valid JSON:
{
  "questions": [
    {
      "text": "Contextual Q2 referencing the item from Q1",
      "options": ["personal scenario", "business scenario", "another option", "fourth option"]
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

YOUR GOAL: Check if we have enough info to categorize. ALMOST NEVER ask follow-up questions.

Ask a follow-up in these 2 cases ONLY:

1. VEHICLE/MILEAGE TRACKING:
   If they said VEHICLE for business use:
   - "Delivery work", "Business travel", "Courier work", "Bike for deliveries"
   → Ask ONCE about mileage tracking (important for HMRC)

2. MIXED SHOPPING - "Yes - some items were":
   If they answered "Yes - some items were" to the multiple products question
   → Ask ONE TEXT INPUT QUESTION (no options):

   For content_creation: "What did you buy for your content and approximately how much did those items cost in total?"
   For freelancing: "What did you buy for client work/projects and approximately how much did those items cost in total?"
   For side_hustle: "What did you buy for your side hustle and approximately how much did those items cost in total?"
   For general: "What did you buy for your business and approximately how much did those items cost in total?"

   Options: [] (empty - user types freely)

   Example user input: "Foundation for filming and ring light - about £45 total"

3. ALL OTHER CASES:
   → Return empty questions array [] - we have enough info!

   Examples of NO follow-up needed:
   - "No, all personal" → Categorize as personal
   - "Yes - all for my content" → Categorize as 100% business
   - Single product answered → Categorize based on purpose

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
- Q1="Weekly food shop" Q2="Did you buy anything you'll review/feature in your content?" A="Yes - some items were"
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

Previous: Q1="Weekly food shop" Q2="Did you buy anything you'll review/feature in your content?" A="Yes - some items were"
Next question (text input): "What did you buy for your content and approximately how much did those items cost in total?"
Options: [] (empty - user types freely)

Previous: Q1="Weekly food shop" Q2="Did you buy anything you'll review/feature in your content?" A="No, all personal"
Next question: [] (empty - proceed to categorization as 100% personal)

Previous: Q1="Weekly food shop" Q2="Did you buy anything you'll review/feature in your content?" A="Yes - all for my content"
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

Respond with ONLY valid JSON with exactly 1 question (or empty array if no more questions needed):
{
  "questions": [
    {
      "text": "Follow-up question based on analysis above",
      "options": ["option 1", "option 2", "option 3", "option 4"]
    }
  ]
}

OR if no more questions needed:
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

YOUR GOAL: Generate 2 questions to categorize this expense.

QUESTION 1 (ALWAYS): "What did you buy?"
- Generate 4 SPECIFIC product/item suggestions based on:
  * The merchant name
  * The transaction amount
  * The user's work type (${workTypeDesc})
  * What this merchant typically sells
  * Include BOTH personal AND business-relevant items

QUESTION 2: Ask about business intent/purpose - BE SPECIFIC AND CONTEXTUAL
- Question 2 should be contextual to what they likely bought
- Include SPECIFIC scenarios with HMRC-accurate tax treatment
- Include realistic personal AND business options
- Make it easy to admit something is personal
- Clarify when something "feels" work-related but is actually personal under HMRC rules

EXAMPLES:

Boots (£25) - Makeup/Foundation:
Q1: "What did you buy?"
- "Makeup/foundation"
- "Skincare products"
- "Hair products"
- "Health/pharmacy items"

Q2: "What was the makeup/foundation for?"
- "To review or feature in a video" (business - 100%)
- "To wear for work events/filming" (personal - HMRC says this is still personal grooming)
- "Everyday personal use"
- "As props for set dressing"

Starbucks (£4.50):
Q1: "What did you buy?"
- "Coffee/drink to go"
- "Coffee + pastry"
- "Lunch meeting (food + drinks)"
- "Just a drink"

Q2: "What was this for?"
- "Quick coffee on my own" (personal)
- "Catching up with a friend" (personal)
- "Business meeting/client discussion" (50% deductible)
- "Working session (needed wifi/space)" (50% deductible)

Amazon (£90) - Camera Equipment:
Q1: "What did you buy?"
- "Camera equipment/accessories"
- "Electronics/gadgets"
- "Software/digital product"
- "Books/courses"

Q2: "What will you use the camera equipment for?"
- "Personal photos/memories" (personal)
- "Filming content for my channel" (business - 100%)
- "Both personal and content" (requires split)
- "Upgrading my setup for better videos" (business - 100%)

Currys (£300) - Laptop:
Q1: "What did you buy?"
- "Laptop/computer"
- "Camera/video equipment"
- "Phone/tablet"
- "TV/monitor"

Q2: "What will you use the laptop for?"
- "Personal use and entertainment" (personal)
- "Exclusively for editing videos/content" (business - 100%)
- "Work and some personal use" (requires split)
- "Running my business" (business - 100%)

Tesco (£45) - Ingredients:
Q1: "What did you buy?"
- "Weekly food shop"
- "Specific ingredients"
- "Snacks/drinks"
- "Household essentials"

Q2: "What were these ingredients for?"
- "Regular weekly groceries" (personal)
- "Recipe for a cooking video" (business - 100%)
- "To feature/review in content" (business - 100%)
- "Party/personal cooking" (personal)

Bike Shop (£400):
Q1: "What did you buy?"
- "Bicycle"
- "Bike accessories/parts"
- "Safety gear"
- "Maintenance/repair"

Q2: "What will you use the bike for?"
- "Commuting to work/office" (personal - NOT deductible)
- "Personal exercise/leisure" (personal)
- "Delivery/courier work" (business - 100%)
- "Filming cycling content/reviews" (business - 100%)

IMPORTANT RULES:
- Question 1 MUST be "What did you buy?" with specific product options
- Question 2 MUST be contextual to what they likely bought from Question 1
- Question 2 should reference the product type (e.g., "What was the makeup for?" not "What was this for?")
- Include at least 2 personal options in Question 2
- Include HMRC-accurate scenarios (e.g., "To wear for work events" is PERSONAL grooming, not business)
- Make options specific and realistic, not vague like "personal use"
- Consider what a ${workTypeDesc} might buy from this merchant
- User can type their own answer if none fit

HMRC REMINDERS FOR QUESTION 2:
- Makeup/clothing to WEAR for work = Personal (even if content creation)
- Makeup/items to REVIEW or FEATURE in content = Business
- Commuting = ALWAYS personal (NOT deductible)
- Business travel/delivery = Business
- Meeting friends (even if discussing work) = Personal
- Formal business meeting = Business (50% for meals)

Respond with ONLY valid JSON:
{
  "questions": [
    {
      "text": "What did you buy?",
      "options": ["specific item 1", "specific item 2", "specific item 3", "specific item 4"]
    },
    {
      "text": "Contextual question referencing what they bought (e.g., 'What was the [item] for?')",
      "options": ["specific personal scenario", "specific business scenario", "another realistic option", "fourth option"]
    }
  ]
}`;

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    });

    let responseText = message.content[0].text;

    // Strip markdown code blocks if present
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    const questions = JSON.parse(responseText);

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

2. **When to Claim 100% Business:**
   - Content creator buys makeup FOR a specific video → 100% supplies
   - Freelancer buys equipment FOR client project → 100% supplies
   - Props, materials specifically for content → 100% supplies
   - Software/subscriptions used for business → 100% software

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
   - Phone contract: If genuinely mixed personal/business use

5. **Special Rules:**
   - Business meals: Max 50% deductible (HMRC rule)
   - Mileage: Use 45p/mile (first 10k miles) instead of actual costs
   - Gifts to clients: Max £50/person/year

DECISION PROCESS:
1. Read the user's answer carefully - what did they actually say?
2. Did they indicate clear business intent? (for work/content/client/specific project) → 100% business
3. Did they say it's for commuting or personal use? → 0% personal
4. Is it a dual-use item by nature? (home, car, phone) → Consider split
5. When uncertain, be conservative - don't assume business use

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

EQUIPMENT CASES (100% BUSINESS):
- Q: "Laptop" A: "For work and some personal use"
  → businessPercent: 100, categoryId: "supplies", explanation: "Purchased with business intent - 100% deductible under HMRC 'wholly and exclusively' rule"

- Q: "Camera" A: "To film content"
  → businessPercent: 100, categoryId: "supplies", explanation: "Business equipment for content creation"

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

Respond with ONLY valid JSON:

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
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
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
          model: "claude-sonnet-4-20250514",
          max_tokens: 800,
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
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔧 Plaid environment: ${process.env.PLAID_ENV}`);
  console.log(`🤖 AI categorization: ${process.env.ANTHROPIC_API_KEY ? 'enabled' : 'disabled'}`);
  console.log(`💾 Supabase: ${process.env.SUPABASE_URL ? 'connected' : 'not configured'}`);
});