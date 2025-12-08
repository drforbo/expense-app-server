const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const multer = require('multer');
const pdfParse = require('pdf-parse');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase limit for base64 images

// Configure multer for PDF uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'), false);
    }
  }
});

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

// ============================================
// PDF BANK STATEMENT UPLOAD & TRANSACTION EXTRACTION
// ============================================

// Helper function to extract transactions from PDF using Claude
async function extractTransactionsFromPDF(pdfBuffer) {
  try {
    // Extract text from PDF
    const pdfData = await pdfParse(pdfBuffer);
    const pageCount = pdfData.numpages;

    console.log(`📄 Processing PDF with ${pageCount} pages`);
    console.log(`📝 Extracted ${pdfData.text.length} characters of text`);

    // Truncate text if too long - process in chunks if needed
    const textToProcess = pdfData.text.substring(0, 100000);

    // Use Claude Haiku for fast extraction (much faster than Sonnet)
    const message = await anthropic.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 8192,
      messages: [{
        role: "user",
        content: `You are a bank statement parser. Extract ALL individual transactions from this bank statement text.

IMPORTANT RULES:
1. Extract EVERY transaction you can find - do not skip any
2. For amount: Use POSITIVE numbers for money going OUT (debits/expenses/purchases), NEGATIVE numbers for money coming IN (credits/income/deposits)
3. For dates: Convert to YYYY-MM-DD format
4. For merchant_name: Clean up the name - remove card numbers, reference codes, and extract the actual merchant/payee name
5. Skip balance entries, opening balances, closing balances - only include actual transactions
6. Look for patterns like dates followed by descriptions and amounts
7. Common UK bank formats: "DD MMM" or "DD/MM/YYYY" dates, amounts with £ symbol

BANK STATEMENT TEXT:
${textToProcess}

You MUST respond with ONLY a valid JSON array. No explanation, no markdown, just the raw JSON array starting with [ and ending with ].

Format:
[{"merchant_name": "Tesco", "amount": 45.23, "transaction_date": "2024-01-15", "description": "Original transaction text"}]

If no transactions found, respond with exactly: []`
      }]
    });

    let responseText = message.content[0].text;
    console.log(`🤖 Claude response length: ${responseText.length} chars`);
    console.log(`🤖 First 500 chars: ${responseText.substring(0, 500)}`);
    console.log(`🤖 Last 200 chars: ${responseText.substring(responseText.length - 200)}`);

    // Clean up the response - remove markdown code blocks if present
    responseText = responseText.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();

    // Check if the response was truncated (starts with [ but doesn't end with ])
    if (responseText.startsWith('[') && !responseText.trim().endsWith(']')) {
      console.log('⚠️ Response appears truncated, attempting to fix...');
      // Find the last complete JSON object and close the array
      const lastCompleteObject = responseText.lastIndexOf('},');
      if (lastCompleteObject > 0) {
        responseText = responseText.substring(0, lastCompleteObject + 1) + ']';
        console.log(`✅ Fixed truncated response, cut at position ${lastCompleteObject}`);
      } else {
        // Try to find a single complete object
        const lastBrace = responseText.lastIndexOf('}');
        if (lastBrace > 0) {
          responseText = responseText.substring(0, lastBrace + 1) + ']';
          console.log(`✅ Fixed truncated response with single object fix`);
        }
      }
    }

    // Find the JSON array in the response - greedy match to get full array
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('❌ No JSON array found in response');
      console.error('❌ Full response:', responseText.substring(0, 2000));
      return [];
    }

    let transactions;
    try {
      transactions = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      console.error('❌ JSON parse error:', parseError.message);
      console.error('❌ Attempted to parse (first 1000 chars):', jsonMatch[0].substring(0, 1000));
      console.error('❌ Attempted to parse (last 500 chars):', jsonMatch[0].substring(jsonMatch[0].length - 500));
      return [];
    }

    console.log(`✅ Extracted ${transactions.length} transactions from PDF`);

    return transactions;
  } catch (error) {
    console.error('❌ Error extracting transactions from PDF:', error);
    throw error;
  }
}

// Upload and process bank statement PDF
app.post('/api/upload_statement', upload.single('pdf'), async (req, res) => {
  try {
    const { user_id } = req.body;
    const file = req.file;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    if (!file) {
      return res.status(400).json({ error: 'PDF file is required' });
    }

    console.log(`📤 Uploading statement for user: ${user_id}`);
    console.log(`📄 File: ${file.originalname}, Size: ${(file.size / 1024).toFixed(1)}KB`);

    // 1. Upload PDF to Supabase Storage
    const fileName = `${user_id}/${Date.now()}_${file.originalname}`;
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from('bank-statements')
      .upload(fileName, file.buffer, {
        contentType: 'application/pdf',
        upsert: false
      });

    if (uploadError) {
      console.error('❌ Storage upload error:', uploadError);
      throw new Error(`Failed to upload PDF: ${uploadError.message}`);
    }

    // Get public URL
    const { data: { publicUrl } } = supabaseAdmin.storage
      .from('bank-statements')
      .getPublicUrl(fileName);

    console.log(`✅ PDF uploaded to storage: ${fileName}`);

    // 2. Create statement record (status: processing)
    const { data: statement, error: stmtError } = await supabaseAdmin
      .from('bank_statements')
      .insert({
        user_id,
        filename: file.originalname,
        file_url: publicUrl,
        status: 'processing'
      })
      .select()
      .single();

    if (stmtError) {
      console.error('❌ Error creating statement record:', stmtError);
      throw stmtError;
    }

    console.log(`📝 Statement record created: ${statement.id}`);

    // 3. Extract transactions using Claude
    console.log('🤖 Extracting transactions with AI...');
    const transactions = await extractTransactionsFromPDF(file.buffer);

    // 4. Save transactions with batch insert and deduplication
    const validTransactions = transactions
      .filter(txn => txn.merchant_name && txn.amount !== undefined && txn.transaction_date)
      .map(txn => {
        const hashInput = `${txn.transaction_date}_${txn.amount}_${txn.merchant_name}`.toLowerCase().trim();
        const transactionHash = crypto.createHash('md5').update(hashInput).digest('hex');
        return {
          user_id,
          statement_id: statement.id,
          merchant_name: txn.merchant_name,
          amount: parseFloat(txn.amount),
          transaction_date: txn.transaction_date,
          description: txn.description || null,
          transaction_hash: transactionHash
        };
      });

    let savedCount = 0;
    let duplicateCount = 0;

    // Batch insert in chunks of 100 for better performance
    const BATCH_SIZE = 100;
    for (let i = 0; i < validTransactions.length; i += BATCH_SIZE) {
      const batch = validTransactions.slice(i, i + BATCH_SIZE);
      const { data, error: insertError } = await supabaseAdmin
        .from('uploaded_transactions')
        .upsert(batch, {
          onConflict: 'user_id,transaction_hash',
          ignoreDuplicates: true
        })
        .select();

      if (insertError) {
        console.error('⚠️  Batch insert error:', insertError);
      } else {
        savedCount += data?.length || 0;
      }
    }

    duplicateCount = validTransactions.length - savedCount;
    console.log(`✅ Saved ${savedCount} transactions, ${duplicateCount} duplicates skipped`);

    // 5. Update statement record with results
    await supabaseAdmin
      .from('bank_statements')
      .update({
        status: 'completed',
        transaction_count: savedCount
      })
      .eq('id', statement.id);

    res.json({
      success: true,
      statement_id: statement.id,
      transactions_found: transactions.length,
      transactions_saved: savedCount,
      duplicates_skipped: duplicateCount
    });

  } catch (error) {
    console.error('❌ Error uploading statement:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get list of uploaded statements for a user
app.post('/api/get_statements', async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const { data, error } = await supabaseAdmin
      .from('bank_statements')
      .select('*')
      .eq('user_id', user_id)
      .order('upload_date', { ascending: false });

    if (error) throw error;

    res.json(data || []);

  } catch (error) {
    console.error('❌ Error getting statements:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get uncategorized transactions for a user
app.post('/api/get_uncategorized_transactions', async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    console.log('📊 Getting uncategorized transactions for user:', user_id);

    // Get all uploaded transactions with statement info
    const { data: uploaded, error: uploadedError } = await supabaseAdmin
      .from('uploaded_transactions')
      .select('*, bank_statements(filename)')
      .eq('user_id', user_id)
      .order('transaction_date', { ascending: false });

    if (uploadedError) throw uploadedError;

    console.log(`📥 Found ${uploaded?.length || 0} uploaded transactions`);

    // Get categorized transaction IDs
    const { data: categorized, error: catError } = await supabaseAdmin
      .from('categorized_transactions')
      .select('source_transaction_id')
      .eq('user_id', user_id);

    if (catError) throw catError;

    const categorizedIds = new Set(categorized?.map(t => t.source_transaction_id) || []);

    // Also check for split transactions
    const splitBaseIds = new Set();
    for (const id of categorizedIds) {
      if (id && id.includes('_split_')) {
        const baseId = id.substring(0, id.indexOf('_split_'));
        splitBaseIds.add(baseId);
      }
    }

    console.log(`📋 Found ${categorizedIds.size} categorized transactions`);

    // Filter out already categorized
    const uncategorized = (uploaded || []).filter(t => {
      if (categorizedIds.has(t.id)) return false;
      if (splitBaseIds.has(t.id)) return false;
      return true;
    });

    // Transform to match existing frontend format
    const transactions = uncategorized.map(t => ({
      transaction_id: t.id,
      name: t.merchant_name,
      merchant_name: t.merchant_name,
      amount: parseFloat(t.amount),
      date: t.transaction_date,
      category: [], // No category yet
      description: t.description,
      statement_filename: t.bank_statements?.filename || null
    }));

    console.log(`✅ Returning ${transactions.length} uncategorized transactions`);

    res.json({
      transactions,
      count: transactions.length
    });

  } catch (error) {
    console.error('❌ Error getting uncategorized transactions:', error);
    res.status(500).json({ error: error.message });
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

// Bulk generate Q1 for multiple transactions (for pre-loading)
app.post('/api/bulk_generate_first_questions', async (req, res) => {
  try {
    const { transactions, userProfile } = req.body;
    console.log('⚡ Bulk generating Q1 for', transactions.length, 'transactions');

    const workTypeDesc = userProfile?.work_type === 'content_creation' ? 'content creator'
      : userProfile?.work_type === 'freelancing' ? 'freelancer'
      : userProfile?.work_type === 'side_hustle' ? 'side hustler'
      : userProfile?.custom_work_type || 'self-employed';

    const businessStructureDesc = userProfile?.tracking_goal === 'sole_trader' ? 'sole trader'
      : userProfile?.tracking_goal === 'limited_company' ? 'limited company director'
      : 'self-employed (not yet registered)';

    // Helper function to generate Q1 for a single transaction
    const generateQ1 = async (transaction) => {
      const isIncome = transaction.amount < 0;

      const prompt = isIncome
        ? `You are a UK tax assistant helping a ${workTypeDesc} (${businessStructureDesc}) categorize income.

TRANSACTION (INCOME):
- Merchant/Payer: ${transaction.merchant_name || transaction.name}
- Amount: £${Math.abs(transaction.amount)}
- Date: ${transaction.date}

YOUR GOAL: Generate Q1 ONLY - ask what this income is for.

QUESTION 1: "What is this income for?"
- Generate 4 SPECIFIC suggestions based on:
  * The merchant/payer name (${transaction.merchant_name || transaction.name})
  * The transaction amount (£${Math.abs(transaction.amount)})
  * What this ${workTypeDesc} typically receives income from
  * Include BOTH business AND personal income options

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
}`
        : `You are a UK tax assistant helping a ${workTypeDesc} (${businessStructureDesc}) categorize expenses.

TRANSACTION:
- Merchant: ${transaction.merchant_name || transaction.name}
- Amount: £${Math.abs(transaction.amount)}
- Date: ${transaction.date}

YOUR GOAL: Generate Q1 ONLY - ask what they bought.

QUESTION 1: "What did you buy?"
- Generate 4 SPECIFIC suggestions based on:
  * The merchant name (${transaction.merchant_name || transaction.name})
  * The transaction amount (£${Math.abs(transaction.amount)})
  * What this merchant typically sells
  * Include BOTH specific items AND general shopping options
  * Include BOTH personal AND business-relevant items for a ${workTypeDesc}

Respond with ONLY valid JSON with ONE question:
{
  "questions": [
    {
      "text": "What did you buy?",
      "options": ["specific option 1", "specific option 2", "multiple items option", "specific option 4"]
    }
  ]
}`;

      try {
        const message = await anthropic.messages.create({
          model: "claude-3-5-haiku-20241022",
          max_tokens: 400,
          messages: [{ role: "user", content: prompt }]
        });

        let responseText = message.content[0].text;
        responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        const firstBrace = responseText.indexOf('{');
        const lastBrace = responseText.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
          responseText = responseText.substring(firstBrace, lastBrace + 1);
        }

        const result = JSON.parse(responseText);
        return {
          transaction_id: transaction.transaction_id,
          questions: result.questions
        };
      } catch (error) {
        console.error(`Error generating Q1 for ${transaction.merchant_name || transaction.name}:`, error.message);
        return {
          transaction_id: transaction.transaction_id,
          questions: null,
          error: error.message
        };
      }
    };

    // Process in batches to avoid rate limits (50 requests/min limit)
    const BATCH_SIZE = 10; // Process 10 at a time
    const BATCH_DELAY = 1500; // 1.5 second delay between batches
    const results = [];

    for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
      const batch = transactions.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(t => generateQ1(t));
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      const successCount = results.filter(r => r.questions).length;
      console.log(`✅ Generated Q1 for ${successCount}/${transactions.length} transactions`);

      // Add delay between batches (except for the last batch)
      if (i + BATCH_SIZE < transactions.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
      }
    }

    res.json({ results });
  } catch (error) {
    console.error('❌ Error in bulk question generation:', error);
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

    const businessStructureDesc = userProfile?.tracking_goal === 'sole_trader' ? 'sole trader'
      : userProfile?.tracking_goal === 'limited_company' ? 'limited company director'
      : 'self-employed (not yet registered)';

    const isSoleTrader = userProfile?.tracking_goal === 'sole_trader' || userProfile?.tracking_goal === 'not_registered';
    const isLimitedCompany = userProfile?.tracking_goal === 'limited_company';

    // Check if this is income or expense
    const isIncome = transaction.amount < 0; // Plaid uses negative for income credits

    const expenseCategories = `
- supplies: Office supplies, materials, equipment, props for content
- software: Business software, tools, subscriptions, apps
- marketing: Advertising, promotions, social media ads, brand materials
- subsistence: Overnight business travel meals only (day-to-day meals and client entertainment NOT deductible)
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
      const incomePrompt = `You are a UK tax expert helping a ${workTypeDesc} (${businessStructureDesc}) categorize business income under HMRC rules.

USER PROFILE:
- Work type: ${workTypeDesc}
- Business structure: ${businessStructureDesc}
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

    const prompt = `You are a UK tax expert helping a ${workTypeDesc} (${businessStructureDesc}) categorize expenses under HMRC rules.

USER PROFILE:
- Work type: ${workTypeDesc}
- Business structure: ${businessStructureDesc}
- Monthly income: £${userProfile?.monthly_income || 'unknown'}

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

5. **Special Rules - FOOD/MEALS (VERY STRICT):**
   - **Day-to-day meals = NOT deductible** (your lunch, coffee, etc. - even if working)
   - **Client entertainment/meals = NOT deductible** (HMRC specifically disallows)
   - **Meals with colleagues discussing work = NOT deductible** (social/personal)
   - **ONLY deductible:** Subsistence when traveling OVERNIGHT for business (hotel meals, etc.)
   - **Temporary business travel:** Meals on day trips MAY be deductible if temporary workplace (not routine/commuting)
   - Mileage: Use 45p/mile (first 10k miles) instead of actual costs
   - Gifts to clients: Max £50/person/year

6. **BUSINESS STRUCTURE-SPECIFIC RULES:**

${isSoleTrader ? `**SOLE TRADER RULES (You are a sole trader):**
   - Simpler expense rules - claim via Self Assessment
   - Home office: Use simplified expenses (£6/week flat rate) - mention this in explanation
   - Vehicle: Claim mileage allowance (45p/mile) rather than actual costs
   - Equipment: Can claim full cost or use Annual Investment Allowance
   - Phone/internet: Can claim business proportion
   - Cannot charge yourself rent or pay yourself a salary
   - Drawings are NOT expenses (taking money out is not deductible)

   **When explaining expenses, mention:**
   - "Claim via Self Assessment"
   - For home office: "Use £6/week simplified expenses instead of actual costs"
   - For vehicle: "Track mileage at 45p/mile"` : ''}

${isLimitedCompany ? `**LIMITED COMPANY RULES (You are a limited company director):**
   - More complex rules - company pays for expenses, you may face benefit in kind tax
   - Home office: Can charge company rent (but may trigger personal tax on rental income)
   - Vehicle: Company car triggers benefit in kind tax (P11D). Mileage claims for personal car better.
   - Equipment: Company purchases - no benefit in kind if "wholly and exclusively" for business
   - Phone/internet: Company can pay if used for business
   - Personal expenses paid by company = benefit in kind (taxable on you personally)
   - Be aware of IR35 rules if you're a contractor via limited company

   **CRITICAL - Benefits in Kind Warnings:**
   - Personal use of company assets may trigger P11D benefit in kind
   - Expenses that benefit you personally (gym, personal meals, clothing to wear) = taxable benefit
   - This means you pay personal tax on the value even if company paid

   **When explaining expenses, add warnings for:**
   - Home office: "Company can pay, but consider £6/week allowance to avoid rental income complications"
   - Vehicle: "Company car triggers benefit in kind tax - consider mileage claims instead"
   - Personal benefit items: "May trigger benefit in kind tax (P11D)"
   - Clothing/grooming: "Personal benefit - may be taxable to you even if company expense"` : ''}

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
- "Camera for filming my content" → Business supplies (100%)
- "Makeup to wear for work events/filming" → Personal (grooming - NOT deductible)
- "Makeup to review or feature in a video" → Business supplies (100%)
- "Foundation for everyday personal use" → Personal

FOOD/MEAL CASES (STRICT UK RULES):
- "Coffee while working" → Personal (NOT deductible)
- "Lunch at desk" → Personal (NOT deductible)
- "Coffee meeting with client" → Personal (client entertainment NOT allowed)
- "Dinner with client to discuss project" → Personal (client entertainment NOT allowed)
- "Meal with colleague discussing work" → Personal (social, NOT deductible)
- "Lunch while traveling to Edinburgh for one-day client meeting" → Business subsistence (MAY be deductible if temporary workplace)
- "Hotel breakfast while on overnight business trip" → Business subsistence (100% deductible)
- "Meal during multi-day conference" → Business subsistence (100% deductible)
- "Groceries for content video" → Business supplies (100% - this is INGREDIENTS/PROPS, not a meal)
- "Takeaway because working late" → Personal (NOT deductible)

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

HMRC RULES (UK TAX YEAR ${hmrcRules.metadata.taxYear}):
1. Business expenses must be "wholly and exclusively" for business
2. Common business expenses for ${workTypeDesc}:
   - Equipment, software, materials = 100% supplies/software
   - Professional services = 100% professional_services
   - Food/meals/restaurants = NOT DEDUCTIBLE (unless overnight business travel)
   - Client entertainment = NOT DEDUCTIBLE
   - Clearly personal items = personal

3. FOOD & MEALS RULES (STRICT IN UK):
   - Regular meals (lunch, coffee, snacks) = NOT deductible
   - Client meals/entertainment = NOT deductible
   - Only deductible: Overnight business travel subsistence
   - This is different from US rules - UK does NOT allow 50% meal deduction

DECISION LOGIC:
- If likely business-related (equipment, software, services) → Mark as business expense
- If clearly personal (groceries, personal shopping) → Mark as personal
- If food/meals/restaurants (Pret, Starbucks, etc.) → Mark as personal (NOT tax deductible)
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
            source_transaction_id: transaction.transaction_id,
            source_type: 'pdf_upload',
            merchant_name: transaction.merchant_name || transaction.name,
            amount: Math.abs(transaction.amount),
            transaction_date: transaction.date,
            category_id: categorization.categoryId,
            category_name: categorization.categoryName,
            business_percent: categorization.businessPercent,
            explanation: categorization.explanation,
            tax_deductible: categorization.taxDeductible,
            user_answers: {}, // Empty for bulk categorization
            rule_version: hmrcRules.metadata.version, // Track which rules were used
          }, {
            onConflict: 'user_id,source_transaction_id'
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

// Get last export date for a user
app.post('/api/get_last_export_date', async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const { data: profile, error } = await supabaseAdmin
      .from('user_profiles')
      .select('last_export_date')
      .eq('user_id', user_id)
      .single();

    if (error) {
      console.error('❌ Error fetching last export date:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ last_export_date: profile?.last_export_date || null });
  } catch (error) {
    console.error('❌ Error getting last export date:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export categorized transactions to CSV
app.post('/api/export_transactions', async (req, res) => {
  try {
    const { user_id, start_date, end_date } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    console.log('📊 Exporting transactions for user:', user_id);
    if (start_date) console.log('📅 Start date:', start_date);
    if (end_date) console.log('📅 End date:', end_date);

    // Build query with optional date filters
    let query = supabaseAdmin
      .from('categorized_transactions')
      .select('*')
      .eq('user_id', user_id);

    // Add date filters if provided
    if (start_date) {
      query = query.gte('transaction_date', start_date);
    }
    if (end_date) {
      query = query.lte('transaction_date', end_date);
    }

    const { data: transactions, error } = await query.order('transaction_date', { ascending: false });

    if (error) {
      console.error('❌ Error fetching transactions:', error);
      return res.status(500).json({ error: error.message });
    }

    // Also fetch gifted items for the same date range
    let giftedQuery = supabaseAdmin
      .from('gifted_items')
      .select('*')
      .eq('user_id', user_id);

    // Add date filters if provided
    if (start_date) {
      giftedQuery = giftedQuery.gte('received_date', start_date);
    }
    if (end_date) {
      giftedQuery = giftedQuery.lte('received_date', end_date);
    }

    const { data: giftedItems, error: giftedError } = await giftedQuery.order('received_date', { ascending: false });

    if (giftedError) {
      console.error('❌ Error fetching gifted items:', giftedError);
      // Don't fail the whole export, just continue without gifted items
    }

    console.log('✅ Found', transactions?.length || 0, 'transactions');
    console.log('✅ Found', giftedItems?.length || 0, 'gifted items');

    if ((!transactions || transactions.length === 0) && (!giftedItems || giftedItems.length === 0)) {
      return res.status(404).json({ error: 'No transactions or gifted items found' });
    }

    // Generate CSV header
    const csvHeaders = [
      'Date',
      'Merchant',
      'Total Amount (£)',
      'Business Amount (£)',
      'Personal Amount (£)',
      'Business %',
      'Type',
      'HMRC Category',
      'Tax Deductible',
      'Notes'
    ];

    // Generate CSV rows for transactions
    const csvRows = (transactions || []).map(txn => {
      // Use absolute value for amounts (Plaid returns negative for income/credits)
      const totalAmount = Math.abs(txn.amount);
      const businessPercent = txn.business_percent || 0;
      const businessAmount = (totalAmount * businessPercent / 100).toFixed(2);
      const personalAmount = (totalAmount * (100 - businessPercent) / 100).toFixed(2);

      // Determine transaction type
      let type;
      if (businessPercent === 100) {
        type = 'Business';
      } else if (businessPercent === 0) {
        type = 'Personal';
      } else {
        type = 'Split';
      }

      // Clean up explanation/notes - remove newlines and quotes for CSV
      const notes = (txn.explanation || '')
        .replace(/"/g, '""') // Escape double quotes
        .replace(/\n/g, ' '); // Replace newlines with spaces

      return [
        txn.transaction_date,
        `"${txn.merchant_name || ''}"`,
        totalAmount.toFixed(2),
        businessAmount,
        personalAmount,
        businessPercent,
        type,
        `"${txn.category_name || 'Uncategorized'}"`,
        txn.tax_deductible ? 'Yes' : 'No',
        `"${notes}"`
      ].join(',');
    });

    // Generate CSV rows for gifted items (as income)
    const giftedRows = (giftedItems || []).map(item => {
      const rrp = parseFloat(item.rrp);

      // Clean up notes
      const notes = (item.notes || '')
        .replace(/"/g, '""')
        .replace(/\n/g, ' ');

      return [
        item.received_date,
        `"${item.item_name || 'Gifted Item'}"`,
        rrp.toFixed(2), // Positive amount for income
        rrp.toFixed(2), // Business income
        '0.00', // No personal portion
        '100', // 100% business
        'Income', // Type
        '"Gifted Item (Income)"', // Category
        'Yes', // Tax relevant
        `"GIFTED ITEM: ${item.item_name} (RRP £${rrp.toFixed(2)})${item.received_from ? ' | From: ' + item.received_from : ''}${item.reason ? ' | Reason: ' + item.reason : ''} ${notes ? '- ' + notes : ''}"`
      ].join(',');
    });

    // Combine headers and rows (transactions + gifted items)
    const allRows = [...csvRows, ...giftedRows];
    const csv = [csvHeaders.join(','), ...allRows].join('\n');

    console.log('✅ CSV generated successfully');

    // Update last export date in user_profiles
    try {
      await supabaseAdmin
        .from('user_profiles')
        .update({ last_export_date: new Date().toISOString() })
        .eq('user_id', user_id);
      console.log('✅ Updated last_export_date for user');
    } catch (updateError) {
      // Don't fail the export if we can't update the timestamp
      console.error('⚠️  Failed to update last_export_date:', updateError);
    }

    // Set headers for file download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="bopp_transactions.csv"');
    res.send(csv);

  } catch (error) {
    console.error('❌ Error exporting transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET endpoint for browser downloads (iOS Safari compatible)
app.get('/api/download_transactions', async (req, res) => {
  try {
    console.log('📥 Download transactions request received (GET)');

    const { user_id, start_date, end_date } = req.query;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    console.log('👤 User ID:', user_id);
    if (start_date) console.log('📅 Start date:', start_date);
    if (end_date) console.log('📅 End date:', end_date);

    // Fetch categorized transactions
    let query = supabaseAdmin
      .from('categorized_transactions')
      .select('*')
      .eq('user_id', user_id);

    // Add date filters if provided
    if (start_date) {
      query = query.gte('transaction_date', start_date);
    }
    if (end_date) {
      query = query.lte('transaction_date', end_date);
    }

    const { data: transactions, error } = await query.order('transaction_date', { ascending: false });

    if (error) {
      console.error('❌ Error fetching transactions:', error);
      return res.status(500).json({ error: 'Failed to fetch transactions' });
    }

    // Debug: Check if user_answers is being fetched
    if (transactions && transactions.length > 0) {
      console.log('📊 Sample transaction user_answers:', transactions[0].user_answers);
      console.log('📊 User answers type:', typeof transactions[0].user_answers);
    }

    // Also fetch gifted items for the same date range
    let giftedQuery = supabaseAdmin
      .from('gifted_items')
      .select('*')
      .eq('user_id', user_id);

    // Add date filters if provided
    if (start_date) {
      giftedQuery = giftedQuery.gte('received_date', start_date);
    }
    if (end_date) {
      giftedQuery = giftedQuery.lte('received_date', end_date);
    }

    const { data: giftedItems, error: giftedError } = await giftedQuery.order('received_date', { ascending: false });

    if (giftedError) {
      console.error('❌ Error fetching gifted items:', giftedError);
      // Don't fail the whole export, just continue without gifted items
    }

    console.log('✅ Found', transactions?.length || 0, 'transactions');
    console.log('✅ Found', giftedItems?.length || 0, 'gifted items');

    if ((!transactions || transactions.length === 0) && (!giftedItems || giftedItems.length === 0)) {
      return res.status(404).send('No transactions or gifted items found for export');
    }

    // Helper function to format user answers for CSV
    const formatUserAnswers = (userAnswers) => {
      console.log('🔍 Formatting user_answers:', JSON.stringify(userAnswers));
      if (!userAnswers || typeof userAnswers !== 'object' || Object.keys(userAnswers).length === 0) {
        console.log('⚠️ User answers is empty or invalid');
        return '';
      }
      // Format as "Q: Answer; Q: Answer"
      const formatted = Object.entries(userAnswers)
        .map(([key, value]) => `${key}: ${value}`)
        .join('; ')
        .replace(/"/g, '""'); // Escape quotes for CSV
      console.log('✅ Formatted result:', formatted);
      return formatted;
    };

    // Generate CSV header
    const csvHeaders = [
      'Date',
      'Merchant',
      'Total Amount (£)',
      'Business Amount (£)',
      'Personal Amount (£)',
      'Business %',
      'Type',
      'HMRC Category',
      'Tax Deductible',
      'Notes',
      'User Answers'
    ];

    // Generate CSV rows for transactions
    const csvRows = (transactions || []).map(txn => {
      // Use absolute value for amounts (Plaid returns negative for income/credits)
      const totalAmount = Math.abs(txn.amount);
      const businessPercent = txn.business_percent || 0;
      const businessAmount = (totalAmount * businessPercent / 100).toFixed(2);
      const personalAmount = (totalAmount * (100 - businessPercent) / 100).toFixed(2);

      return [
        txn.transaction_date,
        `"${(txn.merchant_name || 'Unknown').replace(/"/g, '""')}"`,
        totalAmount.toFixed(2),
        businessAmount,
        personalAmount,
        businessPercent.toFixed(0),
        txn.transaction_type || 'Expense',
        `"${(txn.category_name || 'Uncategorized').replace(/"/g, '""')}"`,
        txn.tax_deductible ? 'Yes' : 'No',
        `"${(txn.explanation || '').replace(/"/g, '""')}"`,
        `"${formatUserAnswers(txn.user_answers)}"`
      ].join(',');
    });

    // Generate CSV rows for gifted items
    const giftedRows = (giftedItems || []).map(item => {
      const estimatedValue = item.estimated_value || 0;

      return [
        item.received_date,
        `"${(item.brand_company || 'Unknown').replace(/"/g, '""')}"`,
        estimatedValue.toFixed(2),
        estimatedValue.toFixed(2), // Business amount = total for gifted items
        '0.00', // Personal amount = 0 for gifted items
        '100', // Business % = 100% for gifted items
        'Income (Gifted)',
        '"Gifts/PR Packages"',
        'Taxable',
        `"Item: ${(item.item_name || 'N/A').replace(/"/g, '""')}, From: ${(item.received_from || 'N/A').replace(/"/g, '""')}, Reason: ${(item.reason || 'N/A').replace(/"/g, '""')}"`,
        '""' // Empty User Answers for gifted items
      ].join(',');
    });

    // Combine headers and rows (transactions + gifted items)
    const allRows = [...csvRows, ...giftedRows];
    const csv = [csvHeaders.join(','), ...allRows].join('\n');

    console.log('✅ CSV generated successfully');

    // Update last export date in user_profiles
    try {
      await supabaseAdmin
        .from('user_profiles')
        .update({ last_export_date: new Date().toISOString() })
        .eq('user_id', user_id);
      console.log('✅ Updated last_export_date for user');
    } catch (updateError) {
      // Don't fail the export if we can't update the timestamp
      console.error('⚠️  Failed to update last_export_date:', updateError);
    }

    // Generate filename with current date
    const fileName = `bopp_transactions_${new Date().toISOString().split('T')[0]}.csv`;

    // Set headers for browser download
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(csv);

  } catch (error) {
    console.error('❌ Error downloading transactions:', error);
    res.status(500).send('Error generating export file');
  }
});

// ============================================================================
// GIFTED ITEMS ENDPOINTS
// ============================================================================

// Recognize item from image using AI vision
app.post('/api/recognize_item', async (req, res) => {
  try {
    const { image_base64 } = req.body;

    if (!image_base64) {
      return res.status(400).json({ error: 'image_base64 is required' });
    }

    console.log('🔍 Analyzing item image...');

    const message = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: image_base64,
            },
          },
          {
            type: 'text',
            text: `Analyze this image and identify the item shown. Provide:
1. A clear, concise item name (e.g., "iPhone 15 Pro", "Nike Air Max Trainers", "Dyson V15 Vacuum")
2. An estimated UK retail price (RRP) in GBP

Respond in this exact JSON format:
{
  "item_name": "Item Name",
  "estimated_rrp": 999.99
}

If you cannot identify the item clearly, use your best judgment based on what you can see. For the price, estimate based on typical UK retail prices for similar items.`,
          },
        ],
      }],
    });

    const responseText = message.content[0].text;
    console.log('🤖 AI response:', responseText);

    // Parse JSON response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not parse AI response');
    }

    const result = JSON.parse(jsonMatch[0]);

    console.log('✅ Item recognized:', result.item_name, '- £' + result.estimated_rrp);

    res.json(result);
  } catch (error) {
    console.error('❌ Error recognizing item:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create a new gifted item
app.post('/api/create_gifted_item', async (req, res) => {
  try {
    const { user_id, item_name, rrp, photo_url, notes, received_date, received_from, reason } = req.body;

    if (!user_id || !item_name || !rrp) {
      return res.status(400).json({ error: 'user_id, item_name, and rrp are required' });
    }

    console.log('📝 Creating gifted item:', item_name, '- £' + rrp);

    const { data, error } = await supabaseAdmin
      .from('gifted_items')
      .insert([{
        user_id,
        item_name,
        rrp,
        photo_url: photo_url || null,
        notes: notes || null,
        received_date: received_date || new Date().toISOString().split('T')[0],
        received_from: received_from || null,
        reason: reason || null,
      }])
      .select()
      .single();

    if (error) {
      console.error('❌ Error creating gifted item:', error);
      return res.status(500).json({ error: error.message });
    }

    console.log('✅ Gifted item created:', data.id);
    res.json(data);
  } catch (error) {
    console.error('❌ Error creating gifted item:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all gifted items for a user
app.post('/api/get_gifted_items', async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    console.log('📊 Fetching gifted items for user:', user_id);

    const { data, error } = await supabaseAdmin
      .from('gifted_items')
      .select('*')
      .eq('user_id', user_id)
      .order('received_date', { ascending: false });

    if (error) {
      console.error('❌ Error fetching gifted items:', error);
      return res.status(500).json({ error: error.message });
    }

    console.log('✅ Found', data.length, 'gifted items');
    res.json(data);
  } catch (error) {
    console.error('❌ Error fetching gifted items:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update a gifted item
app.post('/api/update_gifted_item', async (req, res) => {
  try {
    const { id, item_name, rrp, photo_url, notes, received_date, received_from, reason } = req.body;

    if (!id) {
      return res.status(400).json({ error: 'id is required' });
    }

    console.log('✏️  Updating gifted item:', id);

    const updates = {};
    if (item_name !== undefined) updates.item_name = item_name;
    if (rrp !== undefined) updates.rrp = rrp;
    if (photo_url !== undefined) updates.photo_url = photo_url;
    if (notes !== undefined) updates.notes = notes;
    if (received_date !== undefined) updates.received_date = received_date;
    if (received_from !== undefined) updates.received_from = received_from;
    if (reason !== undefined) updates.reason = reason;
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('gifted_items')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error updating gifted item:', error);
      return res.status(500).json({ error: error.message });
    }

    console.log('✅ Gifted item updated');
    res.json(data);
  } catch (error) {
    console.error('❌ Error updating gifted item:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a gifted item
app.post('/api/delete_gifted_item', async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({ error: 'id is required' });
    }

    console.log('🗑️  Deleting gifted item:', id);

    const { error } = await supabaseAdmin
      .from('gifted_items')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('❌ Error deleting gifted item:', error);
      return res.status(500).json({ error: error.message });
    }

    console.log('✅ Gifted item deleted');
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error deleting gifted item:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Listen on all network interfaces
app.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on http://${HOST}:${PORT}`);
  console.log(`📄 PDF statement upload: enabled`);
  console.log(`🤖 AI categorization: ${process.env.ANTHROPIC_API_KEY ? 'enabled' : 'disabled'}`);
  console.log(`💾 Supabase: ${process.env.SUPABASE_URL ? 'connected' : 'not configured'}`);
});