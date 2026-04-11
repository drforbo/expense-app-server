const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { google } = require('googleapis');
const archiver = require('archiver');
const hmrcRules = require('./hmrc-rules');
require('dotenv').config();

// Initialize Google OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'http://localhost:3000/auth/google/callback'
);

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

// Push notification helper (Expo Push API)
async function sendPushNotification(expoPushToken, title, body) {
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: expoPushToken, sound: 'default', title, body }),
    });
    console.log('Push notification sent');
  } catch (err) {
    console.error('Failed to send push notification:', err);
  }
}

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

// Authentication middleware — verifies Supabase JWT and ensures user_id matches
const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization token' });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Attach verified user to request
    req.user = user;

    // If request includes user_id, verify it matches the authenticated user
    const requestUserId = req.body?.user_id || req.query?.user_id;
    if (requestUserId && requestUserId !== user.id) {
      return res.status(403).json({ error: 'Not authorized to access this data' });
    }

    // Auto-inject user_id if not provided
    if (req.body && !req.body.user_id) {
      req.body.user_id = user.id;
    }

    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    return res.status(401).json({ error: 'Authentication failed' });
  }
};

// Rate limiting - simple in-memory limiter for AI-heavy endpoints
const rateLimits = new Map();
const rateLimit = (maxRequests, windowMs) => (req, res, next) => {
  const userId = req.user?.id || req.ip;
  const key = `${userId}:${req.path}`;
  const now = Date.now();
  const record = rateLimits.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }

  record.count++;
  rateLimits.set(key, record);

  if (record.count > maxRequests) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  next();
};

// ============================================
// PDF BANK STATEMENT UPLOAD & TRANSACTION EXTRACTION
// ============================================

// Helper function to extract transactions directly from PDF buffer using Claude's native PDF support
async function extractTransactionsFromPDF(pdfBuffer) {
  const base64PDF = pdfBuffer.toString('base64');
  console.log(`📄 Sending PDF directly to Claude (${(pdfBuffer.length / 1024).toFixed(0)}KB)`);

  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const stream = await anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 32000,
      messages: [{
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: base64PDF,
            },
          },
          {
            type: "text",
            text: `You are a bank statement parser. Extract ALL individual transactions from this bank statement PDF.

IMPORTANT RULES:
1. Extract EVERY SINGLE transaction - do not skip any, do not summarize
2. For amount: Use POSITIVE numbers for money going OUT (debits/expenses/purchases), NEGATIVE numbers for money coming IN (credits/income/deposits)
3. For dates: Convert to YYYY-MM-DD format. If year is missing, assume current year or most recent past year
4. For merchant_name: Clean up the name - remove card numbers, reference codes, extract the actual merchant/payee name
5. Skip ONLY: balance entries, opening balances, closing balances, statement headers
6. Include ALL: purchases, payments, transfers, direct debits, standing orders, card payments, ATM withdrawals
7. Common UK bank formats: "DD MMM" or "DD/MM/YYYY" dates, amounts with £ symbol
8. Use SHORT descriptions - just the merchant name, not the full transaction text
9. Use COMPACT JSON - no extra whitespace between entries

Respond with ONLY a valid JSON array. No explanation, no markdown, just raw JSON starting with [ and ending with ].

Format:
[{"merchant_name":"Tesco","amount":45.23,"transaction_date":"2024-01-15","description":"Tesco groceries"}]

If no transactions found, respond with exactly: []`
          }
        ]
      }]
    });
    const message = await stream.finalMessage();

    let responseText = message.content[0].text;
    console.log(`📝 Claude stop_reason: ${message.stop_reason}, response length: ${responseText.length}`);
    responseText = responseText.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();

    // If response was truncated, try to salvage by closing the JSON array
    if (message.stop_reason === 'max_tokens' && responseText.startsWith('[') && !responseText.endsWith(']')) {
      console.log('⚠️ Response truncated, attempting to salvage...');
      // Find the last complete object by finding the last '},' or '}'
      const lastCompleteObj = responseText.lastIndexOf('}');
      if (lastCompleteObj > 0) {
        responseText = responseText.substring(0, lastCompleteObj + 1) + ']';
      }
    }

    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('❌ No JSON array found in Claude response');
      console.error('📝 Full response:', responseText.substring(0, 1000));
      return [];
    }

    const transactions = JSON.parse(jsonMatch[0]);
    console.log(`✅ Extracted ${transactions.length} transactions from PDF`);
    return transactions;
    } catch (error) {
      const status = error.status || error.statusCode;
      if ((status === 429 || status === 529) && attempt < MAX_RETRIES) {
        // Parse retry-after header or use escalating delay
        const retryAfter = error.headers?.['retry-after'];
        const delay = retryAfter ? (parseInt(retryAfter) + 5) * 1000 : [90000, 120000, 180000][attempt];
        console.log(`⏳ Rate limited (${status}), waiting ${delay/1000}s before retry (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      console.error('❌ Error extracting transactions from PDF:', error);
      throw error;
    }
  }
}

// Upload bank statement PDF (store only, no processing)
app.post('/api/upload_statement', requireAuth, rateLimit(10, 60000), upload.single('pdf'), async (req, res) => {
  try {
    const { user_id, bank_name, statement_month } = req.body;
    const file = req.file;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    if (!file) {
      return res.status(400).json({ error: 'PDF file is required' });
    }

    console.log(`Uploading statement for user: ${user_id}`);
    console.log(`File: ${file.originalname}, Size: ${(file.size / 1024).toFixed(1)}KB`);
    if (bank_name) console.log(`Bank: ${bank_name}`);
    if (statement_month) console.log(`Month: ${statement_month}`);

    // 1. Upload PDF to Supabase Storage
    const storagePath = `${user_id}/${Date.now()}_${file.originalname}`;
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from('bank-statements')
      .upload(storagePath, file.buffer, {
        contentType: 'application/pdf',
        upsert: false
      });

    if (uploadError) {
      console.error('Storage upload error:', uploadError);
      throw new Error(`Failed to upload PDF: ${uploadError.message}`);
    }

    // Get public URL
    const { data: { publicUrl } } = supabaseAdmin.storage
      .from('bank-statements')
      .getPublicUrl(storagePath);

    console.log(`PDF uploaded to storage: ${storagePath}`);

    // 2. Create statement record (status: pending — no processing yet)
    const { data: statement, error: stmtError } = await supabaseAdmin
      .from('bank_statements')
      .insert({
        user_id,
        filename: file.originalname,
        file_url: publicUrl,
        storage_path: storagePath,
        bank_name: bank_name || null,
        statement_month: statement_month || null,
        status: 'pending'
      })
      .select()
      .single();

    if (stmtError) {
      console.error('Error creating statement record:', stmtError);
      throw stmtError;
    }

    console.log(`Statement record created: ${statement.id} (pending)`);

    // Return immediately — no Claude processing
    res.json({
      success: true,
      statement_id: statement.id
    });

  } catch (error) {
    console.error('Error uploading statement:', error);
    res.status(500).json({ error: error.message });
  }
});

// Poll statement processing status
app.post('/api/statement_status', requireAuth, async (req, res) => {
  try {
    const { statement_id } = req.body;
    if (!statement_id) {
      return res.status(400).json({ error: 'statement_id is required' });
    }
    const { data, error } = await supabaseAdmin
      .from('bank_statements')
      .select('status, transaction_count')
      .eq('id', statement_id)
      .single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error checking statement status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get list of uploaded statements for a user
app.post('/api/get_statements', requireAuth, async (req, res) => {
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

// ============================================
// BATCH PROCESSING & NEW STATEMENT ENDPOINTS
// ============================================

// Standalone Q1 generation helper (extracted from bulk_generate_first_questions)
async function generateQ1ForTransaction(transaction, userProfile) {
  const workTypeDesc = userProfile?.work_type === 'content_creation' ? 'content creator'
    : userProfile?.work_type === 'freelancing' ? 'freelancer'
    : userProfile?.work_type === 'side_hustle' ? 'side hustler'
    : userProfile?.custom_work_type || 'self-employed';

  const isIncome = transaction.amount < 0;
  const merchantName = transaction.merchant_name || transaction.name;
  const amt = Math.abs(transaction.amount);

  const prompt = isIncome
    ? `You are a friendly UK tax assistant helping a ${workTypeDesc} categorize a bank transaction. Be conversational.

TRANSACTION: £${amt} received from "${merchantName}" on ${transaction.date}
USER: ${workTypeDesc}

Ask ONE smart opening question about this specific payment. Your question MUST reference the merchant name and/or amount naturally. Do NOT use generic questions like "What is this income for?"
- Provide 4-5 specific options including at least one personal option (friend paying back, gift, etc.)
- If amount looks like salary (round £1,500-£6,000, or from a company), include PAYE salary option

Respond with ONLY valid JSON:
{
  "questions": [{
    "text": "contextual question referencing ${merchantName} and/or £${amt}",
    "options": ["specific option 1", "specific option 2", "personal option", "another option"]
  }]
}`
    : `You are a friendly UK tax assistant helping a ${workTypeDesc} categorize a bank transaction. Be conversational.

TRANSACTION: £${amt} spent at "${merchantName}" on ${transaction.date}
USER: ${workTypeDesc}

Ask ONE smart opening question about this specific purchase. Your question MUST reference the merchant name and/or amount naturally. Do NOT use generic questions like "What did you buy?"
- Provide 4 specific options based on what ${merchantName} actually sells
- Include both single-item and multiple-items options where relevant

Respond with ONLY valid JSON:
{
  "questions": [{
    "text": "contextual question referencing ${merchantName} and/or £${amt}",
    "options": ["specific option 1", "specific option 2", "multiple items option", "specific option 4"]
  }]
}`;

  const MAX_RETRIES = 4;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const message = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
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
      const status = error.status || error.statusCode;
      const isRetryable = status === 529 || status === 429 || status === 500 || status === 503;

      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = [5000, 15000, 30000, 60000][attempt]; // 5s, 15s, 30s, 60s
        console.log(`[Retry] Q1 for ${merchantName} failed (${status}), retrying in ${delay/1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      console.error(`Error generating Q1 for ${merchantName}:`, error.message);
      return {
        transaction_id: transaction.transaction_id,
        questions: null,
        error: error.message
      };
    }
  }
}

// Background batch processing function
async function processStatementsInBackground(user_id) {
  try {
    console.log(`[Batch] Starting background processing for user: ${user_id}`);

    // Find all pending statements for this user
    const { data: pendingStatements, error: fetchError } = await supabaseAdmin
      .from('bank_statements')
      .select('*')
      .eq('user_id', user_id)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });

    if (fetchError) {
      console.error('[Batch] Error fetching pending statements:', fetchError);
      return;
    }

    if (!pendingStatements || pendingStatements.length === 0) {
      console.log('[Batch] No pending statements found');
      return;
    }

    console.log(`[Batch] Found ${pendingStatements.length} pending statements`);

    const allNewTransactionIds = [];
    let processedCount = 0;
    let failedCount = 0;

    // Process statements SEQUENTIALLY to avoid rate limits
    for (let i = 0; i < pendingStatements.length; i++) {
      const stmt = pendingStatements[i];
      console.log(`[Batch] Processing statement ${i + 1}/${pendingStatements.length}: ${stmt.filename}`);

      try {
        // Update status to processing
        await supabaseAdmin
          .from('bank_statements')
          .update({ status: 'processing' })
          .eq('id', stmt.id);

        // Download the PDF from Supabase Storage
        const storagePath = stmt.storage_path || extractStoragePath(stmt.file_url);
        if (!storagePath) {
          console.error(`[Batch] Cannot determine storage path for statement ${stmt.id}`);
          await supabaseAdmin
            .from('bank_statements')
            .update({ status: 'failed' })
            .eq('id', stmt.id);
          failedCount++;
          continue;
        }

        const { data: fileData, error: downloadError } = await supabaseAdmin.storage
          .from('bank-statements')
          .download(storagePath);

        if (downloadError) {
          console.error(`[Batch] Error downloading PDF for statement ${stmt.id}:`, downloadError);
          await supabaseAdmin
            .from('bank_statements')
            .update({ status: 'failed' })
            .eq('id', stmt.id);
          failedCount++;
          continue;
        }

        // Convert Blob to Buffer
        const arrayBuffer = await fileData.arrayBuffer();
        const pdfBuffer = Buffer.from(arrayBuffer);

        // Extract transactions using Claude
        console.log(`[Batch] Extracting transactions from ${stmt.filename}...`);
        const transactions = await extractTransactionsFromPDF(pdfBuffer);

        // Save transactions with dedup logic
        const validTransactions = transactions
          .filter(txn => txn.merchant_name && txn.amount !== undefined && txn.transaction_date)
          .map(txn => {
            const hashInput = `${txn.transaction_date}_${txn.amount}_${txn.merchant_name}`.toLowerCase().trim();
            const transactionHash = crypto.createHash('md5').update(hashInput).digest('hex');
            return {
              user_id,
              statement_id: stmt.id,
              merchant_name: txn.merchant_name,
              amount: parseFloat(txn.amount),
              transaction_date: txn.transaction_date,
              description: txn.description || null,
              transaction_hash: transactionHash
            };
          });

        let savedCount = 0;
        const BATCH_SIZE = 100;
        for (let j = 0; j < validTransactions.length; j += BATCH_SIZE) {
          const batch = validTransactions.slice(j, j + BATCH_SIZE);
          const { data, error: insertError } = await supabaseAdmin
            .from('uploaded_transactions')
            .upsert(batch, {
              onConflict: 'user_id,transaction_hash',
              ignoreDuplicates: true
            })
            .select();

          if (insertError) {
            console.error('[Batch] Batch insert error:', insertError);
          } else {
            savedCount += data?.length || 0;
            // Collect new transaction IDs for Q1 generation
            if (data) {
              allNewTransactionIds.push(...data.map(t => t.id));
            }
          }
        }

        const duplicateCount = validTransactions.length - savedCount;
        console.log(`[Batch] ${stmt.filename}: Saved ${savedCount} transactions, ${duplicateCount} duplicates skipped`);

        // Update statement status to completed
        await supabaseAdmin
          .from('bank_statements')
          .update({
            status: 'completed',
            transaction_count: savedCount
          })
          .eq('id', stmt.id);

        processedCount++;

        // Wait 90 seconds between statements to respect 30k input tokens/min rate limit
        if (i < pendingStatements.length - 1) {
          console.log(`[Batch] Waiting 90s before next statement (rate limit: 30k tokens/min)...`);
          await new Promise(resolve => setTimeout(resolve, 90000));
        }

      } catch (stmtError) {
        console.error(`[Batch] Error processing statement ${stmt.id} (${stmt.filename}):`, stmtError);
        await supabaseAdmin
          .from('bank_statements')
          .update({ status: 'failed' })
          .eq('id', stmt.id);
        failedCount++;

        // Still wait after failures to let rate limit reset
        if (i < pendingStatements.length - 1) {
          console.log(`[Batch] Waiting 90s after failure before next statement...`);
          await new Promise(resolve => setTimeout(resolve, 90000));
        }
      }
    }

    console.log(`[Batch] Extraction complete: ${processedCount} processed, ${failedCount} failed, ${allNewTransactionIds.length} new transactions`);

    // Smart categorize all new transactions in bulk (replaces individual Q1 generation)
    if (allNewTransactionIds.length > 0) {
      try {
        console.log(`[Batch] Running smart categorization for ${allNewTransactionIds.length} transactions...`);

        // Fetch user profile
        const { data: userProfile } = await supabaseAdmin
          .from('user_profiles')
          .select('*')
          .eq('user_id', user_id)
          .single();

        // Fetch categorization history
        const { data: history } = await supabaseAdmin
          .from('categorization_history')
          .select('*')
          .eq('user_id', user_id)
          .order('created_at', { ascending: false })
          .limit(200);

        const totalConfirmed = (history || []).length;

        // Fetch the new transactions
        const { data: newTransactions } = await supabaseAdmin
          .from('uploaded_transactions')
          .select('*')
          .in('id', allNewTransactionIds);

        if (newTransactions && newTransactions.length > 0) {
          const workTypeDesc = userProfile?.work_type === 'content_creation' ? 'content creator'
            : userProfile?.work_type === 'freelancing' ? 'freelancer'
            : userProfile?.work_type === 'side_hustle' ? 'side hustler'
            : userProfile?.custom_work_type || 'self-employed';

          const businessStructure = userProfile?.tracking_goal === 'sole_trader' ? 'sole trader'
            : userProfile?.tracking_goal === 'limited_company' ? 'limited company director'
            : 'self-employed (not yet registered)';

          // Build history summary
          const historyByMerchant = {};
          for (const h of (history || [])) {
            const key = h.merchant_name_normalized;
            if (!historyByMerchant[key]) {
              historyByMerchant[key] = { entries: [], merchant: h.merchant_name };
            }
            historyByMerchant[key].entries.push(h);
          }
          let historySummary = '';
          for (const [normalized, data] of Object.entries(historyByMerchant)) {
            const catCounts = {};
            for (const e of data.entries) {
              const label = e.category_name + (e.business_percent > 0 ? ` (${e.business_percent}% business)` : ' (personal)');
              catCounts[label] = (catCounts[label] || 0) + 1;
            }
            const countStr = Object.entries(catCounts).map(([cat, n]) => `${cat}: ${n}x`).join(', ');
            historySummary += `- ${data.merchant} (${data.entries.length} times): ${countStr}\n`;
          }

          // Process in chunks of 50
          const CHUNK_SIZE = 50;
          let autoCount = 0;
          let reviewCount = 0;

          for (let i = 0; i < newTransactions.length; i += CHUNK_SIZE) {
            const chunk = newTransactions.slice(i, i + CHUNK_SIZE);
            const chunkTxnList = chunk.map(t => {
              const isIncome = parseFloat(t.amount) < 0;
              return `${t.id} | ${t.merchant_name} | £${Math.abs(parseFloat(t.amount)).toFixed(2)} | ${t.transaction_date} | ${isIncome ? 'INCOME' : 'EXPENSE'}`;
            }).join('\n');

            const prompt = `You are a UK tax categorization expert. Categorize these bank transactions for a ${workTypeDesc}.

USER PROFILE:
- Role: ${userProfile?.job_role || workTypeDesc}
- Business structure: ${businessStructure}
- Main clients: ${(userProfile?.main_clients || []).join(', ') || 'not specified'}
- Works from: ${userProfile?.work_location || 'not specified'}
- Monthly income: £${userProfile?.monthly_income || 'unknown'}

${historySummary ? `CATEGORIZATION HISTORY:\n${historySummary}` : 'NO HISTORY YET - new user.'}

TRANSACTIONS (id | merchant | amount | date | type):
${chunkTxnList}

EXPENSE CATEGORIES: supplies, software, marketing, subsistence, travel, mileage, home_office, professional_services, training, insurance, personal
INCOME CATEGORIES: sponsorship_income, ad_revenue, affiliate_income, client_fees, sales_income, employment_income, other_income, personal

RULES:
1. HMRC "wholly and exclusively" - expenses must be purely for business
2. Food/meals = personal unless overnight business travel
3. Merchant categorized same way 3+ times in history = follow pattern
4. New merchant with no history = use judgment but lower confidence
5. Mixed history = needs_review
6. ATM/cash/own-account transfers = personal
7. Streaming subscriptions = personal unless content creator
8. Groceries = personal

Return ONLY valid JSON array:
[{"transaction_id":"...","status":"auto_business"|"auto_personal"|"needs_review","category_id":"...","category_name":"...","business_percent":0,"tax_deductible":false,"confidence":0.9,"explanation":"...","review_reason":null}]`;

            console.log(`[Batch] Smart categorizing chunk ${Math.floor(i/CHUNK_SIZE) + 1}/${Math.ceil(newTransactions.length/CHUNK_SIZE)}`);

            try {
              const stream = await anthropic.messages.stream({
                model: "claude-sonnet-4-6",
                max_tokens: 16000,
                messages: [{ role: "user", content: prompt }]
              });
              const message = await stream.finalMessage();

              let responseText = message.content[0].text;
              responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
              const firstBracket = responseText.indexOf('[');
              const lastBracket = responseText.lastIndexOf(']');
              if (firstBracket !== -1 && lastBracket !== -1) {
                responseText = responseText.substring(firstBracket, lastBracket + 1);
              }

              const results = JSON.parse(responseText);

              for (const result of results) {
                await supabaseAdmin
                  .from('uploaded_transactions')
                  .update({
                    auto_status: result.status,
                    auto_category_id: result.category_id,
                    auto_category_name: result.category_name,
                    auto_business_percent: result.business_percent,
                    auto_confidence: result.confidence,
                    auto_explanation: result.explanation,
                    auto_review_reason: result.review_reason
                  })
                  .eq('id', result.transaction_id)
                  .eq('user_id', user_id);

                if (result.status === 'needs_review') reviewCount++;
                else autoCount++;
              }
            } catch (chunkError) {
              console.error(`[Batch] Error in smart categorization chunk:`, chunkError.message);
              // Mark chunk as needs_review
              for (const t of chunk) {
                await supabaseAdmin
                  .from('uploaded_transactions')
                  .update({ auto_status: 'needs_review', auto_review_reason: 'Processing error' })
                  .eq('id', t.id);
                reviewCount++;
              }
            }

            if (i + CHUNK_SIZE < newTransactions.length) {
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }

          console.log(`[Batch] Smart categorization complete: ${autoCount} auto, ${reviewCount} review`);
        }
      } catch (smartCatError) {
        console.error('[Batch] Error during smart categorization:', smartCatError);
      }
    }

    // Send push notification
    try {
      const { data: profile, error: profileError } = await supabaseAdmin
        .from('user_profiles')
        .select('expo_push_token')
        .eq('user_id', user_id)
        .single();

      if (!profileError && profile?.expo_push_token) {
        const totalNew = allNewTransactionIds.length;
        await sendPushNotification(
          profile.expo_push_token,
          'Transactions ready for review',
          `${totalNew} transaction${totalNew !== 1 ? 's' : ''} categorized and ready for your review.`
        );
      }
    } catch (notifError) {
      console.error('[Batch] Error sending push notification:', notifError);
    }

    console.log(`[Batch] Background processing complete for user: ${user_id}`);

  } catch (error) {
    console.error('[Batch] Fatal error in background processing:', error);
  }
}

// Helper to extract storage path from a public URL
function extractStoragePath(fileUrl) {
  if (!fileUrl) return null;
  // Public URLs look like: https://<project>.supabase.co/storage/v1/object/public/bank-statements/<path>
  const marker = '/bank-statements/';
  const idx = fileUrl.indexOf(marker);
  if (idx === -1) return null;
  return fileUrl.substring(idx + marker.length);
}

// Trigger batch processing of pending statements
app.post('/api/process_batch', requireAuth, async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    // Count pending statements
    const { data: pendingStatements, error: fetchError } = await supabaseAdmin
      .from('bank_statements')
      .select('id')
      .eq('user_id', user_id)
      .eq('status', 'pending');

    if (fetchError) throw fetchError;

    const pendingCount = pendingStatements?.length || 0;

    if (pendingCount === 0) {
      return res.json({ success: true, processing: false, pending_count: 0 });
    }

    // Fire-and-forget: start background processing
    processStatementsInBackground(user_id).catch(err => {
      console.error('[Batch] Unhandled error in background processing:', err);
    });

    // Return immediately
    res.json({
      success: true,
      processing: true,
      pending_count: pendingCount
    });

  } catch (error) {
    console.error('Error starting batch processing:', error);
    res.status(500).json({ error: error.message });
  }
});

// Register Expo push token
app.post('/api/register_push_token', requireAuth, async (req, res) => {
  try {
    const { user_id, expo_push_token } = req.body;

    if (!user_id || !expo_push_token) {
      return res.status(400).json({ error: 'user_id and expo_push_token are required' });
    }

    const { error } = await supabaseAdmin
      .from('user_profiles')
      .update({ expo_push_token })
      .eq('user_id', user_id);

    if (error) throw error;

    console.log(`Push token registered for user: ${user_id}`);
    res.json({ success: true });

  } catch (error) {
    console.error('Error registering push token:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get statements grouped by month
app.post('/api/get_statements_by_month', requireAuth, async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const { data, error } = await supabaseAdmin
      .from('bank_statements')
      .select('*')
      .eq('user_id', user_id)
      .order('statement_month', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(data || []);

  } catch (error) {
    console.error('Error getting statements by month:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get batch processing status
app.post('/api/batch_status', requireAuth, async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const { data: statements, error } = await supabaseAdmin
      .from('bank_statements')
      .select('status')
      .eq('user_id', user_id);

    if (error) throw error;

    const counts = { pending: 0, processing: 0, completed: 0, failed: 0, total: 0 };
    for (const stmt of (statements || [])) {
      counts[stmt.status] = (counts[stmt.status] || 0) + 1;
      counts.total++;
    }

    res.json(counts);

  } catch (error) {
    console.error('Error getting batch status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a statement and its associated data
app.post('/api/delete_statement', requireAuth, async (req, res) => {
  try {
    const { statement_id, user_id } = req.body;

    if (!statement_id || !user_id) {
      return res.status(400).json({ error: 'statement_id and user_id are required' });
    }

    // Fetch the statement to get storage path
    const { data: statement, error: fetchError } = await supabaseAdmin
      .from('bank_statements')
      .select('*')
      .eq('id', statement_id)
      .eq('user_id', user_id)
      .single();

    if (fetchError) {
      console.error('Error fetching statement for deletion:', fetchError);
      return res.status(404).json({ error: 'Statement not found' });
    }

    // Delete associated uploaded_transactions
    const { error: txnDeleteError } = await supabaseAdmin
      .from('uploaded_transactions')
      .delete()
      .eq('statement_id', statement_id)
      .eq('user_id', user_id);

    if (txnDeleteError) {
      console.error('Error deleting associated transactions:', txnDeleteError);
    }

    // Delete the statement record
    const { error: stmtDeleteError } = await supabaseAdmin
      .from('bank_statements')
      .delete()
      .eq('id', statement_id)
      .eq('user_id', user_id);

    if (stmtDeleteError) throw stmtDeleteError;

    // Delete the PDF from Supabase Storage
    const storagePath = statement.storage_path || extractStoragePath(statement.file_url);
    if (storagePath) {
      const { error: storageDeleteError } = await supabaseAdmin.storage
        .from('bank-statements')
        .remove([storagePath]);

      if (storageDeleteError) {
        console.error('Error deleting PDF from storage:', storageDeleteError);
        // Don't fail the request — the record is already deleted
      }
    }

    console.log(`Statement ${statement_id} deleted (including ${statement.transaction_count || 0} transactions)`);
    res.json({ success: true });

  } catch (error) {
    console.error('Error deleting statement:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get uncategorized transactions for a user
app.post('/api/get_uncategorized_transactions', requireAuth, async (req, res) => {
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
app.post('/api/generate_questions', requireAuth, rateLimit(30, 60000), async (req, res) => {
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
      // CRITICAL: Check for personal income or employment keywords in Q1 answer BEFORE calling AI
      if (numAnswered === 1) {
        const q1Answer = Object.values(previousAnswers)[0]?.toLowerCase() || '';
        const personalKeywords = [
          'friend', 'family', 'paying me back', 'paying back', 'paid me back',
          'reimbursement', 'reimburse', 'gift', 'personal transfer', 'personal',
          'dinner', 'lunch', 'expense', 'borrowed', 'owe', 'owed', 'repay',
          'repaying', 'split', 'share', 'shared'
        ];

        const employmentKeywords = [
          'salary', 'paye', 'wages', 'payroll', 'employer', 'employment',
          'monthly pay', 'weekly pay', 'job', 'work salary', 'my employer',
          'employed', 'employee'
        ];

        const isPersonalIncome = personalKeywords.some(keyword => q1Answer.includes(keyword));
        const isEmploymentIncome = employmentKeywords.some(keyword => q1Answer.includes(keyword));

        if (isPersonalIncome) {
          console.log('🏠 Personal income detected in Q1:', q1Answer);
          res.json({ questions: [] });
          return;
        }

        if (isEmploymentIncome) {
          console.log('💼 Employment income detected in Q1:', q1Answer);
          res.json({ questions: [] });
          return;
        }
      }

      if (numAnswered >= 2) {
        console.log('✅ Income: 2 questions answered, ready to categorize');
        res.json({ questions: [] });
        return;
      }

      const merchantName = transaction.merchant_name || transaction.name;
      const amount = Math.abs(transaction.amount);
      const previousAnswersStr = JSON.stringify(previousAnswers, null, 2);

      const incomePrompt = numAnswered === 0
        ? `You are a friendly UK tax assistant helping a ${workTypeDesc} categorize a bank transaction. Be conversational, not robotic.

TRANSACTION: £${amount} received from "${merchantName}" on ${transaction.date}

USER: ${workTypeDesc}, earns ~£${userProfile?.monthly_income || 'unknown'}/month${userProfile?.has_international_income ? ', has international income' : ''}

YOUR TASK: Ask ONE smart opening question about this specific payment.

RULES:
- Your question MUST reference the merchant name and/or amount naturally
- Do NOT use generic questions like "What is this income for?"
- Infer what this likely is from the merchant name and amount, and frame the question around that
- Provide 4-5 options that are specific to this transaction
- Always include at least one personal option (friend paying back, gift, etc.)
- If the amount looks like a salary (round numbers £1,500-£6,000, or from a company name), include a PAYE salary option

EXAMPLES of good contextual questions:

£500.00 from "GOOGLE ADSENSE" to a content creator:
{
  "questions": [{
    "text": "This looks like a payment from Google AdSense - is this from your content?",
    "options": ["Yes, ad revenue from my videos", "Affiliate or referral payout", "Friend/family paying me back", "Something else"]
  }]
}

£1,200.00 from "BRAND STUDIO LTD" to a content creator:
{
  "questions": [{
    "text": "You received £1,200 from Brand Studio Ltd - what was this for?",
    "options": ["Brand deal or sponsorship", "Client project payment", "My employer paying my salary", "Personal transfer / paying me back"]
  }]
}

£50.00 from "J SMITH" to a freelancer:
{
  "questions": [{
    "text": "£50 from J Smith - do you know what this was for?",
    "options": ["Client payment for work", "Friend or family paying me back", "Gift", "Personal transfer"]
  }]
}

£2,800.00 from "ACME CORP LTD" to a side hustler:
{
  "questions": [{
    "text": "£2,800 from Acme Corp Ltd - this looks like it could be a salary. Is that right?",
    "options": ["Yes, this is my PAYE salary", "Payment for freelance/contract work", "Client paying an invoice", "Something else"]
  }]
}

Respond with ONLY valid JSON. No text before or after.`
        : `You are a friendly UK tax assistant helping a ${workTypeDesc} categorize income. Be conversational.

TRANSACTION: £${amount} from "${merchantName}" on ${transaction.date}
USER: ${workTypeDesc}

CONVERSATION SO FAR:
${previousAnswersStr}

YOUR TASK: Based on their answer, decide what to do next.

IF their answer clearly indicates PERSONAL income (friend, family, gift, paying back, reimbursement, personal):
→ Return {"questions": []}

IF their answer clearly indicates EMPLOYMENT income (salary, PAYE, wages, employer):
→ Return {"questions": []}

IF their answer indicates BUSINESS/SELF-EMPLOYMENT income:
→ Ask ONE follow-up to clarify the income type. Your question MUST reference what they just told you.

EXAMPLE: If they said "Yes, ad revenue from my videos":
{
  "questions": [{
    "text": "Great - is this from a specific platform like YouTube or TikTok, or from multiple sources?",
    "options": ["YouTube/Google ad revenue", "TikTok creator fund", "Ad revenue from multiple platforms", "Other"]
  }]
}

EXAMPLE: If they said "Brand deal or sponsorship":
{
  "questions": [{
    "text": "Got it, a brand deal from ${merchantName}. What type of content was this for?",
    "options": ["Sponsored post/video", "Ongoing brand partnership", "Gifted items to review", "Event appearance or hosting"]
  }]
}

EXAMPLE: If they typed a custom answer like "they paid me for a photoshoot":
{
  "questions": [{
    "text": "A photoshoot payment from ${merchantName} - was this a one-off job or part of an ongoing arrangement?",
    "options": ["One-off client job", "Ongoing contract/retainer", "Part of a brand deal", "Other"]
  }]
}

If Q2 answer was "Other" or unclear → Ask ONE text input question:
{
  "questions": [{
    "text": "Can you briefly describe what ${merchantName} paid you for?",
    "options": []
  }]
}

CRITICAL: Your follow-up MUST acknowledge their previous answer naturally. Do NOT ask a generic question that ignores what they said.

Respond with ONLY valid JSON.`;

      const message = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
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

    // EXPENSE FLOW
    const merchantName = transaction.merchant_name || transaction.name;
    const amount = Math.abs(transaction.amount);
    const previousAnswersStr = JSON.stringify(previousAnswers, null, 2);

    const prompt = !hasPreviousAnswers
      ? `You are a friendly UK tax assistant helping a ${workTypeDesc} categorize a bank transaction. Be conversational, not robotic.

TRANSACTION: £${amount} spent at "${merchantName}" on ${transaction.date}
USER: ${workTypeDesc}, earns ~£${userProfile?.monthly_income || 'unknown'}/month${userProfile?.receives_gifted_items ? ', receives gifted items' : ''}

YOUR TASK: Ask ONE smart opening question about this specific purchase.

RULES:
- Your question MUST reference the merchant name and/or amount naturally
- Do NOT use generic questions like "What did you buy?" - make it specific to the merchant
- Infer what they likely bought from the merchant name and amount
- Provide 4 options that are specific to what this merchant actually sells
- Include both single-item and multiple-items options where relevant

EXAMPLES of good contextual questions:

£4.50 at "STARBUCKS" for a content creator:
{
  "questions": [{
    "text": "£4.50 at Starbucks - was this just a coffee, or did you grab food too?",
    "options": ["Just a coffee/drink", "Coffee and food", "Drinks for a meeting", "Multiple items"]
  }]
}

£47.50 at "BOOTS" for a content creator:
{
  "questions": [{
    "text": "£47.50 at Boots - what did you pick up?",
    "options": ["Makeup or beauty products", "Skincare", "Health/pharmacy items", "A mix of different things"]
  }]
}

£899.00 at "CURRYS" for a freelancer:
{
  "questions": [{
    "text": "£899 at Currys - that looks like a big purchase. What did you get?",
    "options": ["Laptop or computer", "Monitor or display", "Phone or tablet", "Multiple items or accessories"]
  }]
}

£62.30 at "TESCO" for a side hustler:
{
  "questions": [{
    "text": "£62.30 at Tesco - was this a regular food shop or something specific?",
    "options": ["Weekly food shop", "Specific items for a project", "Household essentials", "A mix of groceries and other things"]
  }]
}

£29.99 at "ADOBE" for a content creator:
{
  "questions": [{
    "text": "£29.99 to Adobe - is this a subscription you use for your content?",
    "options": ["Yes, for editing (Premiere, Lightroom, etc.)", "Yes, but mostly personal use", "No, this is personal", "It's for both work and personal"]
  }]
}

Respond with ONLY valid JSON. No text before or after.`
      : (numAnswered === 1
        ? `You are a friendly UK tax assistant helping a ${workTypeDesc} categorize expenses. Be conversational.

TRANSACTION: £${amount} at "${merchantName}" on ${transaction.date}
USER: ${workTypeDesc}

CONVERSATION SO FAR:
${previousAnswersStr}

YOUR TASK: Based on their answer, ask a smart follow-up that acknowledges what they told you.

RULES:
- Your question MUST reference their previous answer naturally - show you understood what they said
- If they typed a custom answer, acknowledge the specific details they mentioned
- Determine if the item is SINGLE or MULTIPLE, and ask accordingly

FOR SINGLE ITEMS: Ask what they'll use it for, referencing the specific item.

EXAMPLE: User said "Ring light"
{
  "questions": [{
    "text": "Nice - is the ring light for filming your content, or personal use?",
    "options": ["For filming/creating content", "For video calls at my day job", "Personal use", "A bit of both"]
  }]
}

EXAMPLE: User typed "hair extensions for a photoshoot"
{
  "questions": [{
    "text": "You mentioned hair extensions for a photoshoot - was this entirely for the shoot, or do you wear them day-to-day too?",
    "options": ["Only for the photoshoot/content", "Mostly for content but I wear them generally", "I wear them all the time, just happened to use them for a shoot", "They were a one-off for this specific job"]
  }]
}

EXAMPLE: User said "Laptop"
{
  "questions": [{
    "text": "What will you mainly use the laptop for?",
    "options": ["Editing content/running my business", "Personal use and entertainment", "Both work and personal", "Replacing an old work laptop"]
  }]
}

FOR MULTIPLE ITEMS: Ask if any were for business, personalized to their work type.

EXAMPLE: User said "Weekly food shop"
{
  "questions": [{
    "text": "Was any of the food shop for your ${workTypeDesc === 'content creator' ? 'content' : workTypeDesc === 'freelancer' ? 'work' : 'business'}, or all personal?",
    "options": ["All personal", "All for my ${workTypeDesc === 'content creator' ? 'content' : 'work'}", "Some items were for ${workTypeDesc === 'content creator' ? 'content' : 'work'}"]
  }]
}

EXAMPLE: User typed "bought ingredients for a recipe video and normal groceries"
{
  "questions": [{
    "text": "You mentioned recipe video ingredients mixed with normal groceries - roughly how much of the £${amount} was for the video ingredients?",
    "options": []
  }]
}

CRITICAL: Your question MUST show you read and understood their answer. Never ask a generic follow-up.

Respond with ONLY valid JSON.`
        : `You are a friendly UK tax assistant helping a ${workTypeDesc} categorize expenses. Be conversational.

TRANSACTION: £${amount} at "${merchantName}" on ${transaction.date}
USER: ${workTypeDesc}

CONVERSATION SO FAR:
${previousAnswersStr}

NUMBER OF ANSWERS: ${numAnswered}

YOUR TASK: Decide if we have enough info, or ask ONE final follow-up.

CRITICAL: If we have 3+ answers, ALWAYS return {"questions": []} - we have enough.

ONLY ask a follow-up for these cases (and only if <3 answers):

1. MIXED SHOPPING ("some items", "some things", "Yes - some"):
   → Ask a TEXT INPUT question (options: []) asking what they bought for work and roughly how much it cost
   → Your question MUST reference their previous answers

   EXAMPLE: Previous answers mention "some items were for content" from a Tesco shop:
   {
     "questions": [{
       "text": "What did you pick up for your content from Tesco, and roughly how much did those items cost?",
       "options": []
     }]
   }

2. VEHICLE for business use:
   → Ask about mileage tracking (important for HMRC)

   EXAMPLE: They said a bike is for delivery work:
   {
     "questions": [{
       "text": "Since you use the bike for deliveries, do you track your business mileage?",
       "options": ["Yes, I keep a mileage log", "No, but I can estimate", "I use it for all my deliveries", "I don't track it"]
     }]
   }

3. ALL OTHER CASES → return {"questions": []}

No follow-up needed examples:
- "All personal" → done
- "All for my content" → done
- Single item + clear purpose → done
- Custom answer with enough detail → done

Respond with ONLY valid JSON.`);

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001", // Use Haiku for faster question generation
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
app.post('/api/bulk_generate_first_questions', requireAuth, rateLimit(10, 60000), async (req, res) => {
  try {
    const { transactions, userProfile } = req.body;
    console.log('Bulk generating Q1 for', transactions.length, 'transactions');

    // Process in batches to avoid rate limits (50 req/min on API)
    const BATCH_SIZE = 8;
    const BATCH_DELAY = 12000; // 12 second delay between batches (~40 req/min)
    const results = [];

    for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
      const batch = transactions.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(t => generateQ1ForTransaction(t, userProfile));
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      const successCount = results.filter(r => r.questions).length;
      console.log(`Generated Q1 for ${successCount}/${transactions.length} transactions`);

      // Add delay between batches (except for the last batch)
      if (i + BATCH_SIZE < transactions.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
      }
    }

    res.json({ results });
  } catch (error) {
    console.error('Error in bulk question generation:', error);
    res.status(500).json({ error: error.message });
  }
});

// Categorize transaction based on user's answers
app.post('/api/categorize_from_answers', requireAuth, rateLimit(30, 60000), async (req, res) => {
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
- employment_income: PAYE salary from an employer (already taxed at source)
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

   EMPLOYMENT INCOME (PAYE salary - already taxed at source):
   - Salary/wages from an employer
   - PAYE income
   - Regular employment pay
   → businessPercent: 100, taxDeductible: false, categoryId: "employment_income"
   Note: This is NOT self-employment income. Tax is already deducted via PAYE.

   BUSINESS/SELF-EMPLOYMENT INCOME (taxable):
   - Client payments, sponsorships, platform revenue, sales
   - Anything earned through self-employment
   → businessPercent: 100, taxDeductible: true, use appropriate business category

2. **Income Categories for Self Assessment:**
   - Sponsorships/brand deals → sponsorship_income
   - Ad revenue from platforms → ad_revenue
   - Affiliate commissions → affiliate_income
   - Client work/consulting → client_fees
   - Product/merchandise sales → sales_income
   - PAYE salary from employer → employment_income
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
3. Check for EMPLOYMENT/PAYE INCOME keywords:
   - "salary", "paye", "wages", "employer", "employment", "payroll"
   - "monthly pay", "weekly pay", "my employer", "employee"
4. If personal keywords found → businessPercent: 0, taxDeductible: false, categoryId: "personal"
5. If employment keywords found → businessPercent: 100, taxDeductible: false, categoryId: "employment_income"
6. If business/self-employment income → Read Q2 (if exists) and match to business category
7. Business income → businessPercent: 100, taxDeductible: true

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

EMPLOYMENT INCOME (PAYE - already taxed):
Q1: "PAYE salary from my employer"
→ categoryId: "employment_income", categoryName: "Employment Income", businessPercent: 100, taxDeductible: false, explanation: "PAYE salary - tax already deducted at source by your employer"

Q1: "Salary from employer"
→ categoryId: "employment_income", categoryName: "Employment Income", businessPercent: 100, taxDeductible: false, explanation: "Employment salary - already taxed via PAYE"

Q1: "Monthly wages"
→ categoryId: "employment_income", categoryName: "Employment Income", businessPercent: 100, taxDeductible: false, explanation: "Employment wages - tax deducted at source"

BUSINESS INCOME (taxable - self-employment):
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

FOR EMPLOYMENT INCOME (PAYE salary, wages):
- businessPercent: 100
- taxDeductible: false
- categoryId: "employment_income"
- categoryName: "Employment Income"
- Explanation: Mention it's already taxed via PAYE

FOR BUSINESS/SELF-EMPLOYMENT INCOME (earned income):
- businessPercent: 100
- taxDeductible: true
- categoryId: appropriate business category (sponsorship_income, ad_revenue, etc.)
- categoryName: friendly name
- Explanation: Mention it's taxable business income

CRITICAL VALIDATION:
1. Did user say "friend", "paying back", "gift", "personal", "reimbursement"?
   → If YES: businessPercent: 0, taxDeductible: false, categoryId: "personal"
2. Did user say "salary", "paye", "wages", "employer", "employment"?
   → If YES: businessPercent: 100, taxDeductible: false, categoryId: "employment_income"
3. Is this earned self-employment/business income?
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

FOR EMPLOYMENT INCOME:
{
  "categoryId": "employment_income",
  "categoryName": "Employment Income",
  "businessPercent": 100,
  "explanation": "PAYE salary - tax already deducted at source by your employer",
  "taxDeductible": false
}

FOR BUSINESS/SELF-EMPLOYMENT INCOME:
{
  "categoryId": "one of the business income category IDs",
  "categoryName": "friendly display name (e.g., Sponsorship Income, Ad Revenue)",
  "businessPercent": 100,
  "explanation": "Brief explanation - mention it's taxable business income",
  "taxDeductible": true,
  "foreignIncome": true or false (only if from outside UK)
}`;

      const message = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
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
      model: "claude-haiku-4-5-20251001",
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
app.post('/api/bulk_categorize', requireAuth, rateLimit(10, 60000), async (req, res) => {
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
          model: "claude-haiku-4-5-20251001",
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

// ============================================================
// SMART CATEGORIZATION SYSTEM
// ============================================================

/**
 * Smart bulk categorize - sends all uncategorized transactions to Claude
 * in one call with user profile + categorization history for context
 */
app.post('/api/smart_categorize', requireAuth, async (req, res) => {
  try {
    const user_id = req.body.user_id || req.user?.id;
    console.log(`[SmartCat] Starting smart categorization for user: ${user_id}`);

    // 1. Fetch uncategorized transactions
    const { data: uploaded, error: uploadedError } = await supabaseAdmin
      .from('uploaded_transactions')
      .select('*')
      .eq('user_id', user_id)
      .in('auto_status', ['pending'])
      .order('transaction_date', { ascending: false });

    if (uploadedError) throw uploadedError;

    // Filter out already-categorized ones
    const { data: categorized } = await supabaseAdmin
      .from('categorized_transactions')
      .select('source_transaction_id')
      .eq('user_id', user_id);

    const categorizedIds = new Set((categorized || []).map(c => c.source_transaction_id));
    const uncategorized = (uploaded || []).filter(t => !categorizedIds.has(t.id));

    if (uncategorized.length === 0) {
      return res.json({ message: 'No transactions to categorize', results: [] });
    }

    console.log(`[SmartCat] ${uncategorized.length} uncategorized transactions`);

    // 2. Fetch user profile
    const { data: userProfile } = await supabaseAdmin
      .from('user_profiles')
      .select('*')
      .eq('user_id', user_id)
      .single();

    // 3. Fetch categorization history (last 200)
    const { data: history } = await supabaseAdmin
      .from('categorization_history')
      .select('*')
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .limit(200);

    // 4. Fetch merchant patterns
    const { data: patterns } = await supabaseAdmin
      .from('merchant_patterns')
      .select('*')
      .eq('user_id', user_id);

    // 5. Build context
    const totalConfirmed = (history || []).length;
    const learningPhase = totalConfirmed < 50 ? 1 : totalConfirmed < 200 ? 2 : 3;

    const workTypeDesc = userProfile?.work_type === 'content_creation' ? 'content creator'
      : userProfile?.work_type === 'freelancing' ? 'freelancer'
      : userProfile?.work_type === 'side_hustle' ? 'side hustler'
      : userProfile?.custom_work_type || 'self-employed';

    const businessStructure = userProfile?.tracking_goal === 'sole_trader' ? 'sole trader'
      : userProfile?.tracking_goal === 'limited_company' ? 'limited company director'
      : 'self-employed (not yet registered)';

    // Summarize history by merchant
    const historyByMerchant = {};
    for (const h of (history || [])) {
      const key = h.merchant_name_normalized;
      if (!historyByMerchant[key]) {
        historyByMerchant[key] = { entries: [], merchant: h.merchant_name };
      }
      historyByMerchant[key].entries.push(h);
    }

    let historySummary = '';
    for (const [normalized, data] of Object.entries(historyByMerchant)) {
      const catCounts = {};
      for (const e of data.entries) {
        const label = e.category_name + (e.business_percent > 0 ? ` (${e.business_percent}% business)` : ' (personal)');
        catCounts[label] = (catCounts[label] || 0) + 1;
      }
      const countStr = Object.entries(catCounts).map(([cat, n]) => `${cat}: ${n}x`).join(', ');
      historySummary += `- ${data.merchant} (${data.entries.length} times): ${countStr}\n`;
    }

    // 6. Build transaction list for prompt
    const txnList = uncategorized.map(t => {
      const isIncome = parseFloat(t.amount) < 0;
      return `${t.id} | ${t.merchant_name} | £${Math.abs(parseFloat(t.amount)).toFixed(2)} | ${t.transaction_date} | ${isIncome ? 'INCOME' : 'EXPENSE'}`;
    }).join('\n');

    // 7. Process in chunks of 50 to stay within token limits
    const CHUNK_SIZE = 50;
    const allResults = [];

    for (let i = 0; i < uncategorized.length; i += CHUNK_SIZE) {
      const chunk = uncategorized.slice(i, i + CHUNK_SIZE);
      const chunkTxnList = chunk.map(t => {
        const isIncome = parseFloat(t.amount) < 0;
        return `${t.id} | ${t.merchant_name} | £${Math.abs(parseFloat(t.amount)).toFixed(2)} | ${t.transaction_date} | ${isIncome ? 'INCOME' : 'EXPENSE'}`;
      }).join('\n');

      const prompt = `You are a UK tax categorization expert. Categorize these bank transactions for a ${workTypeDesc}.

USER PROFILE:
- Role: ${userProfile?.job_role || workTypeDesc}
- Business structure: ${businessStructure}
- Main clients: ${(userProfile?.main_clients || []).join(', ') || 'not specified'}
- Works from: ${userProfile?.work_location || 'not specified'}
- Monthly income: £${userProfile?.monthly_income || 'unknown'}

${historySummary ? `CATEGORIZATION HISTORY (what this user has previously confirmed):\n${historySummary}` : 'NO CATEGORIZATION HISTORY YET - this is a new user.'}

TRANSACTIONS TO CATEGORIZE (format: id | merchant | amount | date | type):
${chunkTxnList}

EXPENSE CATEGORIES:
- supplies: Office supplies, materials, equipment, props
- software: Business software, tools, subscriptions, apps
- marketing: Advertising, promotions, social media ads
- subsistence: Overnight business travel meals ONLY (day-to-day meals NOT deductible)
- travel: Business travel costs (trains, flights, parking - NOT commuting)
- mileage: Business mileage (45p/mile first 10k, 25p after)
- home_office: Rent, utilities, internet for home workspace
- professional_services: Accountant, lawyer, consultant fees
- training: Courses, books, professional development
- insurance: Business insurance premiums
- personal: Non-business expense (not deductible)

INCOME CATEGORIES:
- sponsorship_income: Sponsorships, brand deals
- ad_revenue: Platform ad revenue
- affiliate_income: Affiliate commissions
- client_fees: Client work, consulting, freelance projects
- sales_income: Product/merchandise sales
- employment_income: PAYE salary (already taxed)
- other_income: Other business income
- personal: Personal transfer, gift, friend paying back (not taxable)

RULES:
1. HMRC "wholly and exclusively" rule - expenses must be purely for business
2. Food/meals/restaurants: default to personal UNLESS user history shows business pattern
3. If merchant has been categorized the same way 3+ times in history, follow that pattern
4. If merchant is new (no history), use your best judgment but mark confidence lower
5. If merchant has mixed history (sometimes business, sometimes personal), mark as needs_review
6. ATM withdrawals, cash, transfers between own accounts = personal unless clear business pattern
7. Subscriptions (Netflix, Spotify, Disney+) = personal unless user is a content creator reviewing content
8. Groceries/supermarkets = personal unless strong business evidence

For each transaction return:
- status: "auto_business", "auto_personal", or "needs_review"
- category_id: from the lists above
- category_name: human-readable name
- business_percent: 0-100
- tax_deductible: true/false
- confidence: 0.0-1.0
- explanation: brief reason (10 words max)
- review_reason: null, or why it needs review

Return ONLY a valid JSON array. No markdown, no explanation outside the JSON.
[{"transaction_id":"...","status":"...","category_id":"...","category_name":"...","business_percent":0,"tax_deductible":false,"confidence":0.9,"explanation":"...","review_reason":null}]`;

      console.log(`[SmartCat] Processing chunk ${Math.floor(i/CHUNK_SIZE) + 1}/${Math.ceil(uncategorized.length/CHUNK_SIZE)} (${chunk.length} transactions)`);

      const MAX_RETRIES = 3;
      let chunkResults = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const stream = await anthropic.messages.stream({
            model: "claude-sonnet-4-6",
            max_tokens: 16000,
            messages: [{ role: "user", content: prompt }]
          });
          const message = await stream.finalMessage();

          let responseText = message.content[0].text;
          responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

          const firstBracket = responseText.indexOf('[');
          const lastBracket = responseText.lastIndexOf(']');
          if (firstBracket !== -1 && lastBracket !== -1) {
            responseText = responseText.substring(firstBracket, lastBracket + 1);
          }

          chunkResults = JSON.parse(responseText);
          break;
        } catch (error) {
          const status = error.status || error.statusCode;
          if ((status === 529 || status === 429) && attempt < MAX_RETRIES) {
            const delay = [5000, 15000, 30000][attempt];
            console.log(`[SmartCat] API error ${status}, retrying in ${delay/1000}s`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          console.error(`[SmartCat] Error processing chunk:`, error.message);
          // Mark all in chunk as needs_review on failure
          chunkResults = chunk.map(t => ({
            transaction_id: t.id,
            status: 'needs_review',
            category_id: null,
            category_name: null,
            business_percent: 0,
            tax_deductible: false,
            confidence: 0,
            explanation: 'AI unavailable',
            review_reason: 'Processing error'
          }));
          break;
        }
      }

      if (chunkResults) {
        allResults.push(...chunkResults);
      }

      // Delay between chunks
      if (i + CHUNK_SIZE < uncategorized.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // 8. Save results to uploaded_transactions
    let autoCount = 0;
    let reviewCount = 0;

    for (const result of allResults) {
      const { error: updateError } = await supabaseAdmin
        .from('uploaded_transactions')
        .update({
          auto_status: result.status,
          auto_category_id: result.category_id,
          auto_category_name: result.category_name,
          auto_business_percent: result.business_percent,
          auto_confidence: result.confidence,
          auto_explanation: result.explanation,
          auto_review_reason: result.review_reason
        })
        .eq('id', result.transaction_id)
        .eq('user_id', user_id);

      if (updateError) {
        console.error(`[SmartCat] Error updating transaction ${result.transaction_id}:`, updateError);
      } else {
        if (result.status === 'needs_review') reviewCount++;
        else autoCount++;
      }
    }

    console.log(`[SmartCat] Complete: ${autoCount} auto-categorized, ${reviewCount} need review`);

    res.json({
      success: true,
      learning_phase: learningPhase,
      total_confirmed: totalConfirmed,
      auto_categorized: autoCount,
      needs_review: reviewCount,
      total: allResults.length,
      results: allResults
    });
  } catch (error) {
    console.error('[SmartCat] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get transactions grouped for the review screen
 */
app.post('/api/get_review_transactions', requireAuth, async (req, res) => {
  try {
    const user_id = req.body.user_id || req.user?.id;

    // Get all uploaded transactions with auto_status set
    const { data: transactions, error } = await supabaseAdmin
      .from('uploaded_transactions')
      .select('*')
      .eq('user_id', user_id)
      .order('transaction_date', { ascending: false });

    if (error) throw error;

    // Filter out already categorized
    const { data: categorized } = await supabaseAdmin
      .from('categorized_transactions')
      .select('source_transaction_id')
      .eq('user_id', user_id);

    const categorizedIds = new Set((categorized || []).map(c => c.source_transaction_id));
    const uncategorized = (transactions || []).filter(t => !categorizedIds.has(t.id));

    // Get learning phase
    const { count: historyCount } = await supabaseAdmin
      .from('categorization_history')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user_id);

    const totalConfirmed = historyCount || 0;
    const learningPhase = totalConfirmed < 50 ? 1 : totalConfirmed < 200 ? 2 : 3;

    // Split by status
    const autoBusiness = uncategorized.filter(t => t.auto_status === 'auto_business');
    const autoPersonal = uncategorized.filter(t => t.auto_status === 'auto_personal');
    const needsReview = uncategorized.filter(t => t.auto_status === 'needs_review');
    const pending = uncategorized.filter(t => t.auto_status === 'pending' || !t.auto_status);

    // Group needs_review by normalized merchant
    const merchantGroups = {};
    for (const t of needsReview) {
      const normalized = normalizeMerchantName(t.merchant_name);
      if (!merchantGroups[normalized]) {
        merchantGroups[normalized] = {
          merchant: t.merchant_name,
          normalized,
          transactions: [],
          total_amount: 0
        };
      }
      merchantGroups[normalized].transactions.push(t);
      merchantGroups[normalized].total_amount += Math.abs(parseFloat(t.amount));
    }

    const groupedReview = Object.values(merchantGroups).map(g => ({
      ...g,
      count: g.transactions.length,
      total_amount: g.total_amount.toFixed(2)
    })).sort((a, b) => b.count - a.count);

    res.json({
      learning_phase: learningPhase,
      total_confirmed: totalConfirmed,
      auto_business: autoBusiness,
      auto_personal: autoPersonal,
      needs_review: groupedReview,
      pending_count: pending.length,
      summary: {
        auto_business_count: autoBusiness.length,
        auto_personal_count: autoPersonal.length,
        needs_review_count: needsReview.length,
        pending_count: pending.length
      }
    });
  } catch (error) {
    console.error('Error getting review transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Confirm or correct auto-categorized transactions
 */
app.post('/api/confirm_categorization', requireAuth, async (req, res) => {
  try {
    const user_id = req.body.user_id || req.user?.id;
    const { transaction_ids, action, correction } = req.body;
    // action: 'confirm' or 'correct'
    // correction: { category_id, category_name, business_percent, tax_deductible } (only for 'correct')

    if (!transaction_ids || !Array.isArray(transaction_ids) || !action) {
      return res.status(400).json({ error: 'Missing transaction_ids or action' });
    }

    // Fetch the transactions
    const { data: transactions, error: fetchError } = await supabaseAdmin
      .from('uploaded_transactions')
      .select('*')
      .in('id', transaction_ids)
      .eq('user_id', user_id);

    if (fetchError) throw fetchError;

    let confirmedCount = 0;

    for (const txn of transactions) {
      const isConfirm = action === 'confirm';
      const categoryId = isConfirm ? txn.auto_category_id : correction.category_id;
      const categoryName = isConfirm ? txn.auto_category_name : correction.category_name;
      const businessPercent = isConfirm ? txn.auto_business_percent : correction.business_percent;
      const taxDeductible = isConfirm
        ? (txn.auto_category_id !== 'personal' && txn.auto_business_percent > 0)
        : correction.tax_deductible;

      // Save to categorized_transactions
      const { error: catError } = await supabaseAdmin
        .from('categorized_transactions')
        .upsert({
          user_id,
          source_transaction_id: txn.id,
          source_type: 'pdf_upload',
          merchant_name: txn.merchant_name,
          amount: Math.abs(parseFloat(txn.amount)),
          transaction_date: txn.transaction_date,
          category_id: categoryId,
          category_name: categoryName,
          business_percent: businessPercent,
          explanation: isConfirm ? txn.auto_explanation : (correction.explanation || 'User corrected'),
          tax_deductible: taxDeductible,
          user_answers: {}
        }, {
          onConflict: 'user_id,source_transaction_id'
        });

      if (catError) {
        console.error(`Error saving categorization for ${txn.id}:`, catError);
        continue;
      }

      // Save to categorization_history (learning memory)
      await supabaseAdmin
        .from('categorization_history')
        .insert({
          user_id,
          merchant_name: txn.merchant_name,
          merchant_name_normalized: normalizeMerchantName(txn.merchant_name),
          category_id: categoryId,
          category_name: categoryName,
          business_percent: businessPercent,
          tax_deductible: taxDeductible,
          amount: Math.abs(parseFloat(txn.amount)),
          transaction_date: txn.transaction_date,
          categorization_source: isConfirm ? 'auto_confirmed' : 'auto_corrected',
          was_corrected: !isConfirm,
          original_category_id: !isConfirm ? txn.auto_category_id : null
        });

      // Update merchant pattern
      const merchantName = txn.merchant_name;
      const normalizedMerchant = normalizeMerchantName(merchantName);

      if (normalizedMerchant) {
        const { data: existingPattern } = await supabaseAdmin
          .from('merchant_patterns')
          .select('*')
          .eq('user_id', user_id)
          .eq('merchant_name_normalized', normalizedMerchant)
          .single();

        const amount = Math.abs(parseFloat(txn.amount));
        const now = new Date().toISOString();
        const newEntry = {
          categoryId, categoryName, businessPercent,
          amount, date: now,
          source: isConfirm ? 'auto_confirmed' : 'auto_corrected'
        };

        if (existingPattern) {
          const categoryHistory = [...(existingPattern.category_history || []), newEntry].slice(-20);
          const categoryCounts = {};
          for (const entry of categoryHistory) {
            const key = `${entry.categoryId}|${entry.businessPercent}`;
            categoryCounts[key] = (categoryCounts[key] || 0) + 1;
          }
          const mostCommon = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0];
          const [mostCommonKey] = mostCommon;
          const [mcCatId, mcBizPct] = mostCommonKey.split('|');
          const mcEntry = categoryHistory.find(e => e.categoryId === mcCatId && e.businessPercent === parseInt(mcBizPct));

          await supabaseAdmin.from('merchant_patterns').update({
            most_common_category_id: mcCatId,
            most_common_category_name: mcEntry?.categoryName,
            most_common_business_percent: parseInt(mcBizPct),
            occurrence_count: existingPattern.occurrence_count + 1,
            last_categorization_date: now,
            category_history: categoryHistory,
            updated_at: now
          }).eq('id', existingPattern.id);
        } else {
          await supabaseAdmin.from('merchant_patterns').insert({
            user_id,
            merchant_name_normalized: normalizedMerchant,
            most_common_category_id: categoryId,
            most_common_category_name: categoryName,
            most_common_business_percent: businessPercent,
            occurrence_count: 1,
            last_categorization_date: now,
            category_history: [newEntry],
            created_at: now,
            updated_at: now
          });
        }
      }

      // Mark as processed
      await supabaseAdmin
        .from('uploaded_transactions')
        .update({ auto_status: isConfirm ? 'confirmed' : 'corrected' })
        .eq('id', txn.id);

      confirmedCount++;
    }

    console.log(`[SmartCat] ${action === 'confirm' ? 'Confirmed' : 'Corrected'} ${confirmedCount}/${transaction_ids.length} transactions`);

    res.json({
      success: true,
      confirmed: confirmedCount,
      total: transaction_ids.length
    });
  } catch (error) {
    console.error('Error confirming categorization:', error);
    res.status(500).json({ error: error.message });
  }
});

// Re-categorize transaction based on user feedback
app.post('/api/recategorize_with_feedback', requireAuth, rateLimit(20, 60000), async (req, res) => {
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
      model: "claude-haiku-4-5-20251001",
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
app.post('/api/generate-guide', requireAuth, rateLimit(5, 60000), async (req, res) => {
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
app.post('/api/get_last_export_date', requireAuth, async (req, res) => {
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
app.post('/api/export_transactions', requireAuth, async (req, res) => {
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

// ZIP export: CSV + receipt files bundled together
app.post('/api/export_bundle', requireAuth, async (req, res) => {
  try {
    const { user_id, start_date, end_date } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    console.log('📦 Exporting transaction bundle for user:', user_id);

    // Fetch categorized transactions
    let query = supabaseAdmin
      .from('categorized_transactions')
      .select('*')
      .eq('user_id', user_id);

    if (start_date) query = query.gte('transaction_date', start_date);
    if (end_date) query = query.lte('transaction_date', end_date);

    const { data: transactions, error } = await query.order('transaction_date', { ascending: false });
    if (error) {
      console.error('❌ Error fetching transactions:', error);
      return res.status(500).json({ error: error.message });
    }

    // Fetch gifted items
    let giftedQuery = supabaseAdmin
      .from('gifted_items')
      .select('*')
      .eq('user_id', user_id);
    if (start_date) giftedQuery = giftedQuery.gte('received_date', start_date);
    if (end_date) giftedQuery = giftedQuery.lte('received_date', end_date);

    const { data: giftedItems } = await giftedQuery.order('received_date', { ascending: false });

    if ((!transactions || transactions.length === 0) && (!giftedItems || giftedItems.length === 0)) {
      return res.status(404).json({ error: 'No transactions found' });
    }

    // Build enhanced CSV with evidence columns
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
      'Qualified',
      'Business Use Explanation',
      'Content Link',
      'Receipt File',
      'Notes',
    ];

    const escCsv = (str) => {
      if (!str) return '""';
      return `"${String(str).replace(/"/g, '""').replace(/\n/g, ' ')}"`;
    };

    // Track receipts to download
    const receiptFiles = [];

    const csvRows = (transactions || []).map((txn, idx) => {
      const totalAmount = Math.abs(txn.amount);
      const businessPercent = txn.business_percent || 0;
      const businessAmount = (totalAmount * businessPercent / 100).toFixed(2);
      const personalAmount = (totalAmount * (100 - businessPercent) / 100).toFixed(2);

      let type = 'Personal';
      if (businessPercent === 100) type = 'Business';
      else if (businessPercent > 0) type = 'Split';

      // Build a readable receipt filename
      let receiptFilename = '';
      if (txn.receipt_image_url) {
        const ext = txn.receipt_image_url.split('.').pop()?.split('?')[0] || 'jpg';
        const safeDate = (txn.transaction_date || 'unknown').replace(/\//g, '-');
        const safeMerchant = (txn.merchant_name || 'unknown')
          .replace(/[^a-zA-Z0-9]/g, '_')
          .substring(0, 30);
        receiptFilename = `${safeDate}_${safeMerchant}_${totalAmount.toFixed(2)}.${ext}`;

        receiptFiles.push({
          url: txn.receipt_image_url,
          filename: receiptFilename,
        });
      }

      return [
        txn.transaction_date,
        escCsv(txn.merchant_name),
        totalAmount.toFixed(2),
        businessAmount,
        personalAmount,
        businessPercent,
        type,
        escCsv(txn.category_name || 'Uncategorized'),
        txn.tax_deductible ? 'Yes' : 'No',
        txn.qualified ? 'Yes' : 'No',
        escCsv(txn.business_use_explanation),
        escCsv(txn.content_link),
        receiptFilename ? `receipts/${receiptFilename}` : '',
        escCsv(txn.explanation),
      ].join(',');
    });

    // Gifted item rows
    const giftedRows = (giftedItems || []).map(item => {
      const rrp = parseFloat(item.rrp || 0);
      return [
        item.received_date,
        escCsv(item.item_name || 'Gifted Item'),
        rrp.toFixed(2),
        rrp.toFixed(2),
        '0.00',
        '100',
        'Income',
        '"Gifted Item (Income)"',
        'Yes',
        'Yes',
        escCsv(`GIFTED: ${item.item_name}${item.received_from ? ' from ' + item.received_from : ''}`),
        '""',
        '',
        escCsv(item.notes),
      ].join(',');
    });

    const csv = [csvHeaders.join(','), ...csvRows, ...giftedRows].join('\n');

    // Set up ZIP stream
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="bopp_export.zip"');

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => {
      console.error('❌ Archive error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'ZIP creation failed' });
    });
    archive.pipe(res);

    // Add CSV to archive
    archive.append(csv, { name: 'transactions.csv' });

    // Download and add each receipt
    let downloadedCount = 0;
    for (const receipt of receiptFiles) {
      try {
        // Extract the storage path from the public URL
        // URL format: https://{project}.supabase.co/storage/v1/object/public/receipts/{path}
        const urlParts = receipt.url.split('/storage/v1/object/public/receipts/');
        if (urlParts.length < 2) {
          console.warn('⚠️  Skipping receipt with unexpected URL format:', receipt.url);
          continue;
        }
        const storagePath = decodeURIComponent(urlParts[1]);

        const { data: fileData, error: fileError } = await supabaseAdmin.storage
          .from('receipts')
          .download(storagePath);

        if (fileError || !fileData) {
          console.warn('⚠️  Failed to download receipt:', storagePath, fileError?.message);
          continue;
        }

        const buffer = Buffer.from(await fileData.arrayBuffer());
        archive.append(buffer, { name: `receipts/${receipt.filename}` });
        downloadedCount++;
      } catch (dlErr) {
        console.warn('⚠️  Error downloading receipt:', receipt.filename, dlErr.message);
      }
    }

    console.log(`✅ Bundle: ${csvRows.length + giftedRows.length} transactions, ${downloadedCount}/${receiptFiles.length} receipts`);

    // Update last export date
    try {
      await supabaseAdmin
        .from('user_profiles')
        .update({ last_export_date: new Date().toISOString() })
        .eq('user_id', user_id);
    } catch (updateError) {
      console.error('⚠️  Failed to update last_export_date:', updateError);
    }

    await archive.finalize();

  } catch (error) {
    console.error('❌ Error exporting bundle:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// GET endpoint for browser downloads (iOS Safari compatible)
app.get('/api/download_transactions', requireAuth, async (req, res) => {
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
      'Has Evidence',
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
        txn.qualified ? 'Yes' : 'No',
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
        'Yes', // Gifted items are always considered to have evidence (they're explicitly tracked)
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
app.post('/api/recognize_item', requireAuth, rateLimit(10, 60000), async (req, res) => {
  try {
    const { image_base64 } = req.body;

    if (!image_base64) {
      return res.status(400).json({ error: 'image_base64 is required' });
    }

    console.log('🔍 Analyzing item image...');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
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
app.post('/api/create_gifted_item', requireAuth, async (req, res) => {
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
app.post('/api/get_gifted_items', requireAuth, async (req, res) => {
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
app.post('/api/update_gifted_item', requireAuth, async (req, res) => {
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
app.post('/api/delete_gifted_item', requireAuth, async (req, res) => {
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

// ============================================
// GMAIL INTEGRATION - EMAIL MEMORY JOGGER
// ============================================

// Exchange authorization code for tokens and save connection
app.post('/api/gmail/connect', requireAuth, async (req, res) => {
  try {
    const { code, userId } = req.body;

    if (!code || !userId) {
      return res.status(400).json({ error: 'Missing code or userId' });
    }

    console.log('🔐 Exchanging Gmail auth code for tokens...');

    // Exchange the code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user's email address
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email;

    console.log(`📧 Connected Gmail account: ${email}`);

    // Save connection to database
    const { error } = await supabaseAdmin
      .from('email_connections')
      .upsert({
        user_id: userId,
        provider: 'gmail',
        email: email,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
        connected_at: new Date().toISOString(),
        is_active: true
      }, {
        onConflict: 'user_id,provider'
      });

    if (error) {
      console.error('❌ Error saving Gmail connection:', error);
      return res.status(500).json({ error: 'Failed to save connection' });
    }

    console.log('✅ Gmail connection saved');
    res.json({ success: true, email });

  } catch (error) {
    console.error('❌ Gmail connect error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get user's email connection status
app.post('/api/gmail/status', requireAuth, async (req, res) => {
  try {
    const { userId } = req.body;

    const { data, error } = await supabaseAdmin
      .from('email_connections')
      .select('email, provider, connected_at, is_active')
      .eq('user_id', userId)
      .eq('provider', 'gmail')
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = not found
      throw error;
    }

    res.json({ connected: !!data, connection: data || null });

  } catch (error) {
    console.error('❌ Gmail status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Disconnect Gmail
app.post('/api/gmail/disconnect', requireAuth, async (req, res) => {
  try {
    const { userId } = req.body;

    const { error } = await supabaseAdmin
      .from('email_connections')
      .delete()
      .eq('user_id', userId)
      .eq('provider', 'gmail');

    if (error) throw error;

    console.log('✅ Gmail disconnected');
    res.json({ success: true });

  } catch (error) {
    console.error('❌ Gmail disconnect error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Search emails for receipts/invoices matching a transaction
app.post('/api/gmail/search', requireAuth, async (req, res) => {
  try {
    const { userId, transactionDate, merchantName, amount } = req.body;

    // Get user's Gmail tokens
    const { data: connection, error: connError } = await supabaseAdmin
      .from('email_connections')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', 'gmail')
      .single();

    if (connError || !connection) {
      return res.status(400).json({ error: 'Gmail not connected' });
    }

    // Set up OAuth client with user's tokens
    const userOAuth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    userOAuth.setCredentials({
      access_token: connection.access_token,
      refresh_token: connection.refresh_token
    });

    // Refresh token if needed
    if (connection.token_expires_at && new Date(connection.token_expires_at) < new Date()) {
      console.log('🔄 Refreshing Gmail token...');
      const { credentials } = await userOAuth.refreshAccessToken();
      userOAuth.setCredentials(credentials);

      // Update stored tokens
      await supabaseAdmin
        .from('email_connections')
        .update({
          access_token: credentials.access_token,
          token_expires_at: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null
        })
        .eq('id', connection.id);
    }

    const gmail = google.gmail({ version: 'v1', auth: userOAuth });

    // Build search query
    const txDate = new Date(transactionDate);
    const startDate = new Date(txDate);
    startDate.setDate(startDate.getDate() - 3); // 3 days before
    const endDate = new Date(txDate);
    endDate.setDate(endDate.getDate() + 3); // 3 days after

    const formatDate = (d) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;

    // Search for receipts, orders, invoices around the transaction date
    const searchTerms = [];

    // Add merchant name variations
    if (merchantName) {
      const cleanMerchant = merchantName.replace(/[^\w\s]/g, '').trim();
      if (cleanMerchant) {
        searchTerms.push(cleanMerchant);
      }
    }

    // Common receipt senders
    const receiptSenders = [
      'amazon', 'paypal', 'uber', 'deliveroo', 'just-eat', 'netflix',
      'spotify', 'apple', 'google', 'microsoft', 'adobe', 'receipt',
      'order', 'invoice', 'confirmation', 'booking'
    ];

    // Build query
    let query = `after:${formatDate(startDate)} before:${formatDate(endDate)}`;

    if (searchTerms.length > 0) {
      query += ` (${searchTerms.join(' OR ')})`;
    } else {
      query += ` (${receiptSenders.join(' OR ')})`;
    }

    console.log(`🔍 Searching Gmail: ${query}`);

    // Search for emails
    const searchResult = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 10
    });

    if (!searchResult.data.messages || searchResult.data.messages.length === 0) {
      return res.json({ matches: [] });
    }

    // Get details of each matching email
    const matches = [];
    for (const msg of searchResult.data.messages.slice(0, 5)) {
      try {
        const email = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full'
        });

        const headers = email.data.payload.headers;
        const subject = headers.find(h => h.name === 'Subject')?.value || 'No subject';
        const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
        const date = headers.find(h => h.name === 'Date')?.value || '';

        // Get snippet/preview
        const snippet = email.data.snippet || '';

        // Try to extract body text for AI analysis
        let bodyText = '';
        if (email.data.payload.body?.data) {
          bodyText = Buffer.from(email.data.payload.body.data, 'base64').toString();
        } else if (email.data.payload.parts) {
          const textPart = email.data.payload.parts.find(p => p.mimeType === 'text/plain');
          if (textPart?.body?.data) {
            bodyText = Buffer.from(textPart.body.data, 'base64').toString();
          }
        }

        matches.push({
          id: msg.id,
          subject,
          from,
          date,
          snippet,
          bodyPreview: bodyText.substring(0, 500)
        });
      } catch (e) {
        console.log('Error fetching email:', e.message);
      }
    }

    // Use Claude to analyze matches and extract relevant info
    if (matches.length > 0 && amount) {
      try {
        const analysisPrompt = `Analyze these emails to find receipts or invoices matching a transaction of £${Math.abs(amount).toFixed(2)} ${merchantName ? `from "${merchantName}"` : ''}.

Emails found:
${matches.map((m, i) => `
[${i + 1}] Subject: ${m.subject}
From: ${m.from}
Date: ${m.date}
Preview: ${m.snippet}
`).join('\n')}

For each email, determine:
1. Is this likely a receipt/invoice for the transaction?
2. What items/services were purchased?
3. Confidence level (high/medium/low)

Return JSON array:
[{
  "emailIndex": 1,
  "isMatch": true/false,
  "confidence": "high/medium/low",
  "summary": "Brief description of what was purchased",
  "extractedAmount": "Amount if found in email"
}]

Only include emails that seem relevant. Return empty array [] if none match.`;

        const analysis = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1000,
          messages: [{ role: 'user', content: analysisPrompt }]
        });

        const responseText = analysis.content[0].text;
        const jsonMatch = responseText.match(/\[[\s\S]*\]/);

        if (jsonMatch) {
          const analyzed = JSON.parse(jsonMatch[0]);

          // Merge analysis with email data
          const enrichedMatches = analyzed
            .filter(a => a.isMatch)
            .map(a => ({
              ...matches[a.emailIndex - 1],
              confidence: a.confidence,
              summary: a.summary,
              extractedAmount: a.extractedAmount
            }));

          return res.json({ matches: enrichedMatches });
        }
      } catch (e) {
        console.log('AI analysis error:', e.message);
      }
    }

    res.json({ matches });

  } catch (error) {
    console.error('❌ Gmail search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// SMART CATEGORIZATION - MERCHANT LEARNING
// ============================================

/**
 * Normalize merchant name for pattern matching
 * Handles variations like "AMZN MKTP UK", "Amazon.co.uk", "AMAZON EU" -> "amazon"
 */
function normalizeMerchantName(name) {
  if (!name) return '';

  let normalized = name
    .toLowerCase()
    .trim()
    // Remove common card transaction prefixes
    .replace(/^(card payment to|payment to|direct debit to|standing order to)\s*/i, '')
    // Remove reference numbers and transaction IDs
    .replace(/\s*ref[:\s]*[\w\d]+/gi, '')
    .replace(/\s*id[:\s]*[\w\d]+/gi, '')
    .replace(/\s*\*+\d+/g, '')
    // Remove dates that appear in transaction descriptions
    .replace(/\s+\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?/g, '')
    // Remove country codes and common suffixes
    .replace(/\s+(uk|gb|eu|com|co\.uk|ltd|limited|inc|plc|llc)\.?$/gi, '')
    // Remove special characters except spaces
    .replace(/[^a-z0-9\s]/g, ' ')
    // Collapse multiple spaces
    .replace(/\s+/g, ' ')
    .trim();

  // Map common merchant variations to canonical names
  const merchantAliases = {
    'amzn': 'amazon',
    'amzn mktp': 'amazon',
    'amzn mktplace': 'amazon',
    'amazon prime': 'amazon',
    'amazonprime': 'amazon',
    'amazon eu': 'amazon',
    'pp': 'paypal',
    'paypal': 'paypal',
    'uber trip': 'uber',
    'uber eats': 'uber eats',
    'ubereats': 'uber eats',
    'just eat': 'just eat',
    'justeat': 'just eat',
    'deliveroo': 'deliveroo',
    'tfl': 'tfl',
    'transport for london': 'tfl',
    'trainline': 'trainline',
    'the trainline': 'trainline',
    'spotify': 'spotify',
    'netflix': 'netflix',
    'nflx': 'netflix',
    'disney plus': 'disney plus',
    'disneyplus': 'disney plus',
    'apple': 'apple',
    'apple com bill': 'apple',
    'google': 'google',
    'google play': 'google',
    'microsoft': 'microsoft',
    'msft': 'microsoft',
    'adobe': 'adobe',
    'canva': 'canva',
    'zoom': 'zoom',
    'dropbox': 'dropbox',
    'tesco': 'tesco',
    'sainsburys': 'sainsburys',
    'sainsbury': 'sainsburys',
    'asda': 'asda',
    'morrisons': 'morrisons',
    'aldi': 'aldi',
    'lidl': 'lidl',
    'waitrose': 'waitrose',
    'costa': 'costa',
    'costa coffee': 'costa',
    'starbucks': 'starbucks',
    'pret': 'pret a manger',
    'pret a manger': 'pret a manger',
    'greggs': 'greggs',
    'mcdonalds': 'mcdonalds',
    'mcd': 'mcdonalds',
    'kfc': 'kfc',
    'burger king': 'burger king',
    'bk': 'burger king',
    'boots': 'boots',
    'superdrug': 'superdrug',
  };

  // Check if any alias matches (from start of string)
  for (const [alias, canonical] of Object.entries(merchantAliases)) {
    if (normalized === alias || normalized.startsWith(alias + ' ')) {
      return canonical;
    }
  }

  // Return first 2-3 words as the normalized name (handles "COSTA COFFEE LONDON" -> "costa coffee")
  const words = normalized.split(' ').slice(0, 3).join(' ');
  return words || normalized;
}

/**
 * Update merchant pattern after a categorization
 * POST /api/update_merchant_pattern
 */
app.post('/api/update_merchant_pattern', requireAuth, async (req, res) => {
  try {
    const { user_id, transaction, categorization, categorization_source } = req.body;

    if (!user_id || !transaction || !categorization) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const merchantName = transaction.merchant_name || transaction.name;
    const normalizedMerchant = normalizeMerchantName(merchantName);
    if (!normalizedMerchant) {
      return res.json({ success: true, message: 'No merchant name to track' });
    }

    console.log(`📝 update_merchant_pattern: "${merchantName}" → normalized: "${normalizedMerchant}"`);

    // Get existing pattern for this merchant
    const { data: existingPattern, error: fetchError } = await supabaseAdmin
      .from('merchant_patterns')
      .select('*')
      .eq('user_id', user_id)
      .eq('merchant_name_normalized', normalizedMerchant)
      .single();

    const amount = Math.abs(parseFloat(transaction.amount));
    const now = new Date().toISOString();

    if (existingPattern) {
      // Update existing pattern
      const categoryHistory = existingPattern.category_history || [];
      categoryHistory.push({
        categoryId: categorization.categoryId,
        categoryName: categorization.categoryName,
        businessPercent: categorization.businessPercent,
        amount: amount,
        date: now,
        source: categorization_source || 'manual'
      });

      // Keep last 20 categorizations for this merchant
      const recentHistory = categoryHistory.slice(-20);

      // Calculate most common category
      const categoryCounts = {};
      for (const entry of recentHistory) {
        const key = `${entry.categoryId}|${entry.businessPercent}`;
        categoryCounts[key] = (categoryCounts[key] || 0) + 1;
      }
      const mostCommon = Object.entries(categoryCounts)
        .sort((a, b) => b[1] - a[1])[0];
      const [mostCommonKey] = mostCommon;
      const [mostCommonCategoryId, mostCommonBusinessPercent] = mostCommonKey.split('|');
      const mostCommonEntry = recentHistory.find(e =>
        e.categoryId === mostCommonCategoryId &&
        e.businessPercent === parseInt(mostCommonBusinessPercent)
      );

      // Update amount statistics
      const allAmounts = recentHistory.map(e => e.amount);
      const avgAmount = allAmounts.reduce((a, b) => a + b, 0) / allAmounts.length;
      const minAmount = Math.min(...allAmounts);
      const maxAmount = Math.max(...allAmounts);

      const { error: updateError } = await supabaseAdmin
        .from('merchant_patterns')
        .update({
          most_common_category_id: mostCommonCategoryId,
          most_common_category_name: mostCommonEntry?.categoryName,
          most_common_business_percent: parseInt(mostCommonBusinessPercent),
          typical_answers: categorization.userAnswers,
          occurrence_count: existingPattern.occurrence_count + 1,
          last_categorization_date: now,
          avg_amount: avgAmount,
          min_amount: minAmount,
          max_amount: maxAmount,
          category_history: recentHistory,
          updated_at: now
        })
        .eq('id', existingPattern.id);

      if (updateError) throw updateError;

      console.log(`📊 Updated merchant pattern for "${normalizedMerchant}" (${existingPattern.occurrence_count + 1} occurrences)`);
    } else {
      // Create new pattern
      const { error: insertError } = await supabaseAdmin
        .from('merchant_patterns')
        .insert({
          user_id,
          merchant_name_normalized: normalizedMerchant,
          most_common_category_id: categorization.categoryId,
          most_common_category_name: categorization.categoryName,
          most_common_business_percent: categorization.businessPercent,
          typical_answers: categorization.userAnswers,
          occurrence_count: 1,
          last_categorization_date: now,
          avg_amount: amount,
          min_amount: amount,
          max_amount: amount,
          category_history: [{
            categoryId: categorization.categoryId,
            categoryName: categorization.categoryName,
            businessPercent: categorization.businessPercent,
            amount: amount,
            date: now,
            source: categorization_source || 'manual'
          }],
          created_at: now,
          updated_at: now
        });

      if (insertError) throw insertError;

      console.log(`📊 Created merchant pattern for "${normalizedMerchant}"`);
    }

    res.json({ success: true, normalizedMerchant });

  } catch (error) {
    console.error('❌ Error updating merchant pattern:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get categorization suggestions based on merchant history
 * POST /api/get_categorization_suggestions
 */
app.post('/api/get_categorization_suggestions', requireAuth, async (req, res) => {
  try {
    const { user_id, transaction } = req.body;

    if (!user_id || !transaction) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const merchantName = transaction.merchant_name || transaction.name;
    const normalizedMerchant = normalizeMerchantName(merchantName);
    if (!normalizedMerchant) {
      console.log('🔍 get_suggestions: No merchant name found');
      return res.json({ hasSuggestion: false });
    }

    console.log(`🔍 get_suggestions: "${merchantName}" → normalized: "${normalizedMerchant}"`);

    // Get pattern for this merchant
    const { data: pattern, error } = await supabaseAdmin
      .from('merchant_patterns')
      .select('*')
      .eq('user_id', user_id)
      .eq('merchant_name_normalized', normalizedMerchant)
      .single();

    if (error || !pattern) {
      console.log(`🔍 get_suggestions: No pattern found for "${normalizedMerchant}" (error: ${error?.message || 'none'})`);
      return res.json({ hasSuggestion: false });
    }

    console.log(`🔍 get_suggestions: Found pattern for "${normalizedMerchant}" with ${pattern.occurrence_count} occurrences`);

    // Need at least 1 prior categorization to make a suggestion
    if (pattern.occurrence_count < 1) {
      console.log(`🔍 get_suggestions: Not enough occurrences (${pattern.occurrence_count})`);
      return res.json({ hasSuggestion: false });
    }

    const transactionAmount = Math.abs(parseFloat(transaction.amount));

    // Find the most similar past transaction by amount
    let mostSimilar = null;
    let smallestDiff = Infinity;

    if (pattern.category_history && pattern.category_history.length > 0) {
      for (const entry of pattern.category_history) {
        const diff = Math.abs(entry.amount - transactionAmount);
        if (diff < smallestDiff) {
          smallestDiff = diff;
          mostSimilar = entry;
        }
      }
    }

    // Calculate confidence based on:
    // 1. How many times we've categorized this merchant
    // 2. How similar the amount is to past transactions
    // 3. How consistent the categorization has been

    const occurrenceConfidence = Math.min(pattern.occurrence_count / 5, 1); // Max at 5 occurrences

    const amountRange = pattern.max_amount - pattern.min_amount;
    const amountConfidence = amountRange > 0
      ? Math.max(0, 1 - (smallestDiff / amountRange))
      : (smallestDiff < 5 ? 1 : 0.5); // If all amounts same, high confidence if close

    // Check category consistency
    const categoryHistory = pattern.category_history || [];
    const uniqueCategories = new Set(categoryHistory.map(e => e.categoryId));
    const consistencyConfidence = uniqueCategories.size === 1 ? 1 : 0.7;

    const overallConfidence = (occurrenceConfidence * 0.3 + amountConfidence * 0.3 + consistencyConfidence * 0.4);

    // Build suggestion message
    const formattedDate = mostSimilar?.date
      ? new Date(mostSimilar.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      : null;
    const formattedAmount = mostSimilar?.amount
      ? `£${mostSimilar.amount.toFixed(2)}`
      : null;

    const businessPercentText = pattern.most_common_business_percent === 100
      ? '100% business'
      : pattern.most_common_business_percent === 0
        ? 'Personal'
        : `${pattern.most_common_business_percent}% business`;

    let message = `You've categorized ${transaction.merchant_name} purchases as "${pattern.most_common_category_name}" (${businessPercentText})`;
    if (formattedAmount && formattedDate) {
      message += ` - similar: ${formattedAmount} on ${formattedDate}`;
    }

    res.json({
      hasSuggestion: true,
      suggestion: {
        type: 'merchant_history',
        message,
        normalizedMerchant,
        similarTransaction: mostSimilar ? {
          amount: mostSimilar.amount,
          date: mostSimilar.date,
          categoryId: mostSimilar.categoryId,
          categoryName: mostSimilar.categoryName,
          businessPercent: mostSimilar.businessPercent
        } : null,
        suggestedCategoryId: pattern.most_common_category_id,
        suggestedCategoryName: pattern.most_common_category_name,
        suggestedBusinessPercent: pattern.most_common_business_percent,
        typicalAnswers: pattern.typical_answers,
        confidence: overallConfidence,
        occurrenceCount: pattern.occurrence_count,
        // Flag if this merchant has variable categorizations
        isVariable: uniqueCategories.size > 1
      }
    });

  } catch (error) {
    console.error('❌ Error getting categorization suggestions:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// SUBSCRIPTION DETECTION
// ============================================

/**
 * Detect subscription patterns from uncategorized transactions
 * POST /api/detect_subscriptions
 */
app.post('/api/detect_subscriptions', requireAuth, async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'Missing user_id' });
    }

    console.log('🔄 Detecting subscriptions for user:', user_id);

    // Get all uploaded transactions (not yet categorized)
    const { data: allTransactions, error: txnError } = await supabaseAdmin
      .from('uploaded_transactions')
      .select('*')
      .eq('user_id', user_id)
      .order('transaction_date', { ascending: true });

    if (txnError) throw txnError;

    // Get already categorized transaction IDs
    const { data: categorized, error: catError } = await supabaseAdmin
      .from('categorized_transactions')
      .select('source_transaction_id')
      .eq('user_id', user_id);

    if (catError) throw catError;

    const categorizedIds = new Set(categorized?.map(c => c.source_transaction_id) || []);

    // Get existing subscription patterns (to avoid re-detecting)
    const { data: existingPatterns, error: patternError } = await supabaseAdmin
      .from('subscription_patterns')
      .select('merchant_name_normalized, amount')
      .eq('user_id', user_id);

    if (patternError && patternError.code !== 'PGRST116') throw patternError;

    const existingPatternKeys = new Set(
      (existingPatterns || []).map(p => `${p.merchant_name_normalized}|${p.amount}`)
    );

    // Filter to uncategorized transactions only
    const uncategorized = allTransactions?.filter(t => !categorizedIds.has(t.transaction_id)) || [];

    // Group transactions by normalized merchant + amount (with tolerance)
    const groups = new Map();
    const AMOUNT_TOLERANCE = 0.50; // 50p tolerance

    for (const txn of uncategorized) {
      const merchantName = txn.merchant_name || txn.name || 'Unknown';
      const normalizedMerchant = normalizeMerchantName(merchantName);
      const amount = Math.abs(parseFloat(txn.amount)).toFixed(2);

      // Find existing group with similar amount
      let foundGroup = false;
      for (const [key, group] of groups.entries()) {
        const [groupMerchant, groupAmount] = key.split('|');
        if (groupMerchant === normalizedMerchant) {
          const amountDiff = Math.abs(parseFloat(amount) - parseFloat(groupAmount));
          if (amountDiff <= AMOUNT_TOLERANCE) {
            group.transactions.push(txn);
            foundGroup = true;
            break;
          }
        }
      }

      if (!foundGroup) {
        const key = `${normalizedMerchant}|${amount}`;
        groups.set(key, {
          merchantNormalized: normalizedMerchant,
          merchantDisplay: merchantName,
          amount: parseFloat(amount),
          transactions: [txn]
        });
      }
    }

    // Analyze each group for subscription patterns
    const detectedSubscriptions = [];

    for (const [key, group] of groups.entries()) {
      // Need at least 3 occurrences to detect a pattern
      if (group.transactions.length < 3) continue;

      // Skip if already detected
      const patternKey = `${group.merchantNormalized}|${group.amount.toFixed(2)}`;
      if (existingPatternKeys.has(patternKey)) continue;

      // Sort by date
      const sorted = group.transactions.sort(
        (a, b) => new Date(a.transaction_date).getTime() - new Date(b.transaction_date).getTime()
      );

      // Calculate intervals between transactions
      const intervals = [];
      for (let i = 1; i < sorted.length; i++) {
        const days = Math.round(
          (new Date(sorted[i].transaction_date).getTime() - new Date(sorted[i-1].transaction_date).getTime())
          / (1000 * 60 * 60 * 24)
        );
        intervals.push(days);
      }

      // Determine frequency based on average interval
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      let frequency = null;
      let confidence = 0;

      // Calculate standard deviation for consistency scoring
      const variance = intervals.reduce((sum, val) => sum + Math.pow(val - avgInterval, 2), 0) / intervals.length;
      const stdDev = Math.sqrt(variance);
      const consistencyScore = Math.max(0, 1 - (stdDev / avgInterval));

      if (avgInterval >= 5 && avgInterval <= 9) {
        frequency = 'weekly';
        confidence = consistencyScore * 0.9;
      } else if (avgInterval >= 25 && avgInterval <= 35) {
        frequency = 'monthly';
        confidence = consistencyScore * 0.95;
      } else if (avgInterval >= 350 && avgInterval <= 380) {
        frequency = 'yearly';
        confidence = consistencyScore * 0.85;
      }

      // Only include if we detected a valid frequency with decent confidence
      if (frequency && confidence >= 0.5) {
        const lastTxn = sorted[sorted.length - 1];
        const lastChargeDate = new Date(lastTxn.transaction_date);

        // Calculate next expected date
        let nextExpectedDate = new Date(lastChargeDate);
        if (frequency === 'weekly') nextExpectedDate.setDate(nextExpectedDate.getDate() + 7);
        else if (frequency === 'monthly') nextExpectedDate.setMonth(nextExpectedDate.getMonth() + 1);
        else if (frequency === 'yearly') nextExpectedDate.setFullYear(nextExpectedDate.getFullYear() + 1);

        detectedSubscriptions.push({
          merchantNormalized: group.merchantNormalized,
          merchantDisplay: group.merchantDisplay,
          amount: group.amount,
          frequency,
          avgIntervalDays: Math.round(avgInterval),
          confidence: Math.round(confidence * 100) / 100,
          transactionCount: sorted.length,
          transactions: sorted.map(t => ({
            id: t.transaction_id,
            date: t.transaction_date,
            amount: Math.abs(parseFloat(t.amount))
          })),
          lastChargeDate: lastChargeDate.toISOString().split('T')[0],
          nextExpectedDate: nextExpectedDate.toISOString().split('T')[0]
        });
      }
    }

    // Sort by confidence (highest first)
    detectedSubscriptions.sort((a, b) => b.confidence - a.confidence);

    console.log(`✅ Detected ${detectedSubscriptions.length} subscription patterns`);

    res.json({
      success: true,
      subscriptions: detectedSubscriptions,
      totalDetected: detectedSubscriptions.length
    });

  } catch (error) {
    console.error('❌ Error detecting subscriptions:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Confirm a subscription pattern and categorize all matching transactions
 * POST /api/confirm_subscription
 */
app.post('/api/confirm_subscription', requireAuth, async (req, res) => {
  try {
    const {
      user_id,
      subscription,
      category_id,
      category_name,
      business_percent,
      apply_to_past = true
    } = req.body;

    if (!user_id || !subscription || !category_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    console.log(`✅ Confirming subscription: ${subscription.merchantDisplay} @ £${subscription.amount}`);

    // Save the subscription pattern
    const { data: pattern, error: insertError } = await supabaseAdmin
      .from('subscription_patterns')
      .upsert({
        user_id,
        merchant_name_normalized: subscription.merchantNormalized,
        merchant_name_display: subscription.merchantDisplay,
        amount: subscription.amount,
        frequency: subscription.frequency,
        avg_interval_days: subscription.avgIntervalDays,
        confidence_score: subscription.confidence,
        status: 'confirmed',
        category_id,
        category_name,
        business_percent: business_percent || 0,
        matched_transaction_ids: subscription.transactions.map(t => t.id),
        transaction_count: subscription.transactionCount,
        last_charge_date: subscription.lastChargeDate,
        next_expected_date: subscription.nextExpectedDate,
        confirmed_at: new Date().toISOString()
      }, {
        onConflict: 'user_id,merchant_name_normalized,amount'
      })
      .select()
      .single();

    if (insertError) throw insertError;

    // Categorize all matching past transactions
    let categorizedCount = 0;
    if (apply_to_past && subscription.transactions?.length > 0) {
      for (const txn of subscription.transactions) {
        const { error: catError } = await supabaseAdmin
          .from('categorized_transactions')
          .upsert({
            user_id,
            source_transaction_id: txn.id,
            source_type: 'pdf_upload',
            merchant_name: subscription.merchantDisplay,
            amount: txn.amount,
            transaction_date: txn.date,
            category_id,
            category_name,
            business_percent: business_percent || 0,
            explanation: `Auto-categorized as ${subscription.frequency} subscription`,
            tax_deductible: (business_percent || 0) > 0,
            user_answers: {},
            transaction_type: 'expense',
            categorization_source: 'subscription_auto'
          }, {
            onConflict: 'user_id,source_transaction_id'
          });

        if (!catError) categorizedCount++;
      }
    }

    console.log(`✅ Categorized ${categorizedCount} transactions as subscription`);

    res.json({
      success: true,
      pattern,
      categorizedCount
    });

  } catch (error) {
    console.error('❌ Error confirming subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Reject a subscription pattern (don't show again)
 * POST /api/reject_subscription
 */
app.post('/api/reject_subscription', requireAuth, async (req, res) => {
  try {
    const { user_id, subscription } = req.body;

    if (!user_id || !subscription) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Save as rejected so we don't detect it again
    const { error } = await supabaseAdmin
      .from('subscription_patterns')
      .upsert({
        user_id,
        merchant_name_normalized: subscription.merchantNormalized,
        merchant_name_display: subscription.merchantDisplay,
        amount: subscription.amount,
        frequency: subscription.frequency,
        avg_interval_days: subscription.avgIntervalDays,
        confidence_score: subscription.confidence,
        status: 'rejected',
        matched_transaction_ids: subscription.transactions.map(t => t.id),
        transaction_count: subscription.transactionCount
      }, {
        onConflict: 'user_id,merchant_name_normalized,amount'
      });

    if (error) throw error;

    console.log(`❌ Rejected subscription: ${subscription.merchantDisplay}`);

    res.json({ success: true });

  } catch (error) {
    console.error('❌ Error rejecting subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get confirmed subscriptions for auto-categorization of new transactions
 * POST /api/get_confirmed_subscriptions
 */
app.post('/api/get_confirmed_subscriptions', requireAuth, async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'Missing user_id' });
    }

    const { data: patterns, error } = await supabaseAdmin
      .from('subscription_patterns')
      .select('*')
      .eq('user_id', user_id)
      .eq('status', 'confirmed');

    if (error) throw error;

    res.json({
      success: true,
      subscriptions: patterns || []
    });

  } catch (error) {
    console.error('❌ Error getting confirmed subscriptions:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Listen on all network interfaces
app.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on http://${HOST}:${PORT}`);
  console.log(`📊 Smart categorization: enabled`);
  console.log(`📄 PDF statement upload: enabled`);
  console.log(`🤖 AI categorization: ${process.env.ANTHROPIC_API_KEY ? 'enabled' : 'disabled'}`);
  console.log(`💾 Supabase: ${process.env.SUPABASE_URL ? 'connected' : 'not configured'}`);
  console.log(`📧 Gmail integration: ${process.env.GOOGLE_CLIENT_ID ? 'enabled' : 'disabled'}`);
});