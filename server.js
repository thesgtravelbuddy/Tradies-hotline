import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import Groq, { toFile } from 'groq-sdk';
import axios from 'axios';
import AWS from 'aws-sdk';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { readFileSync, existsSync } from 'node:fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
// Vercel: run DB init once before handling any request (see ensureInitialized).
app.use(async (req, res, next) => {
  // Serverless functions freeze once a response is sent, so DB setup must finish
  // while a request is still alive. Wait for it, but never longer than 12s so a
  // slow database cannot hang health checks or chat.
  if (process.env.VERCEL) {
    await Promise.race([ensureInitialized(), new Promise(r => setTimeout(r, 12000))]);
  }
  next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));
app.use(express.static('.'));

// Serve index.html for root path
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Serve admin.html
app.get('/admin.html', (req, res) => {
  res.sendFile(join(__dirname, 'admin.html'));
});

// Initialize services
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || '' });

// --- Groq configuration ----------------------------------------------------
// Same proven Cendol pattern as before: one pinned model, one direct chat
// completion call, no runtime model discovery and no retry ladder.
//
// NOTE: `mixtral-8x7b-32768` has been decommissioned by Groq and is no longer
// in GET /openai/v1/models, so pinning it would 404 every request. The default
// below is the strongest general chat model currently on Groq's free tier.
// Override with GROQ_MODEL to switch without a code change.
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

// DigitalOcean's gateway kills a request at 30s. Cap our own call at 25s so we
// return a real JSON error instead of the platform's opaque 504.
const GROQ_TIMEOUT_MS = 25000;

// Rejects after `ms` unless the wrapped promise settles first.
function withTimeout(promise, ms, label = 'Groq request') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 8000,
  max: 3
});

const s3 = new AWS.S3({
  endpoint: process.env.DO_SPACES_ENDPOINT,
  accessKeyId: process.env.DO_SPACES_KEY,
  secretAccessKey: process.env.DO_SPACES_SECRET,
  region: 'nyc3'
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key-change-in-production';

// ---- Knowledge repository (multi-trade) ------------------------------------
let kbCache = { at: 0, rows: [] };
const STOP = new Set(('a an the and or but of to in on at for with my our is are was were be been it its this that these those i we you me ' +
  'have has had do does did not no yes just very really so up down out over under again still keep keeps can cant cannot will wont now then ' +
  'there here what when where how why which who very got get getting some any all from by as if than too also').split(' '));

function tokens(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w)).map(w => w.replace(/(ing|ed|es|s)$/, ''));
}

async function loadKnowledge() {
  if (Date.now() - kbCache.at < 5 * 60 * 1000 && kbCache.rows.length) return kbCache.rows;
  const r = await pool.query('SELECT issue_name, trade, data FROM knowledge_base WHERE active = true AND data IS NOT NULL');
  const rows = r.rows.map(x => {
    const d = x.data || {};
    const phrases = [...(d.customer_phrases || []), ...(d.trigger_keywords || [])];
    return { ...d, issue_name: x.issue_name, trade: x.trade,
      _name: new Set(tokens(x.issue_name + ' ' + phrases.join(' '))),
      _bag: new Set(tokens((d.symptoms || []).join(' '))),
      _phrases: phrases.map(p => new Set(tokens(p))).filter(s => s.size >= 2) };
  });
  // Inverse document frequency: rare words ("gas", "possum") count for more than common ones ("water", "house").
  const df = new Map();
  for (const e of rows) for (const w of new Set([...e._name, ...e._bag])) df.set(w, (df.get(w) || 0) + 1);
  const N = rows.length || 1;
  const idf = (w) => Math.log(1 + N / (df.get(w) || 1));
  kbCache = { at: Date.now(), rows, idf };
  return rows;
}

function pickRelevant(entries, conversationText, n = 3) {
  const q = new Set(tokens(conversationText));
  if (!q.size) return [];
  const idf = kbCache.idf || (() => 1);
  const scored = entries.map(e => {
    let score = 0;
    for (const w of q) {
      if (e._name.has(w)) score += 3 * idf(w);
      else if (e._bag.has(w)) score += 1 * idf(w);
    }
    // Whole-phrase boost: most words of a known customer phrase appear in what they said.
    for (const ph of e._phrases) {
      let hit = 0;
      for (const w of ph) if (q.has(w)) hit++;
      const ratio = hit / ph.size;
      if (ratio >= 0.66) score += 6 * ratio;
    }
    return { e, score };
  }).filter(x => x.score >= 3).sort((a, b) => b.score - a.score).slice(0, n);
  const top = scored.length ? scored[0].score : 0;
  return scored.filter(x => x.score >= top * 0.6).map(x => { x.e._score = x.score; return x.e; });
}

function fmtEntry(e) {
  const all = e.questions || [];
  const pri = all.filter(x => x.priority);
  const rest = all.filter(x => !x.priority);
  const line = (x, i) => `  ${i + 1}. ${x.q}  [why: ${x.why}]`;
  const qs = [...pri, ...rest].slice(0, 9).map(line).join('\n');
  const safety = e.safety_instruction ? `\nIf a danger sign is mentioned, say (in your own gentle words): ${e.safety_instruction}` : '';
  return `JOB TYPE: ${e.issue_name} (${e.trade}) - usual urgency: ${e.urgency_default}\n` +
    `Urgent/dangerous signs: ${(e.emergency_indicators || []).join('; ') || 'none noted'}${safety}\n` +
    `Questions that help the tradesperson (the first ${pri.length || 3} matter most; ask only those not yet answered, one at a time):\n${qs}\n` +
    `Facts needed to quote: ${(e.quote_info_needed || []).join('; ')}\n` +
    `Useful photos to ask for: ${(e.photo_requests || []).join('; ')}`;
}

// Build AI system prompt from the repository, tailored to what the customer has said so far
async function buildAIPrompt(conversationText = '', meta = null) {
  const base = `You are the intake assistant for Tradies Hotline, an Australian service that connects customers with tradespeople (plumbers, electricians, carpenters, roofers, appliance repairers, pest controllers and more).

Your job:
1. Work out which kind of job this is from what the customer says.
2. Ask the questions a tradesperson would need answered to quote and schedule the job, one at a time, skipping anything already answered.
3. Be warm and reassuring; customers may be stressed or elderly.
4. NEVER diagnose, suggest causes, or give repair instructions. The only advice allowed is safety: if there are signs of danger (gas smell, sparking or burning smell, water near electrics, sewage overflow, structural collapse, tree on power lines) tell them plainly to call 000 or the gas emergency line, and to stay safe, then carry on gathering details only if they are safe.
5. When you have the main facts (what, where, how long, how bad, access, and anything quote-relevant), say you have what the tradesperson needs and invite them to tap the Next button.`;
  try {
    const rows = await loadKnowledge();
    const hits = pickRelevant(rows, conversationText);
    if (meta) meta.hits = hits.map(h => ({ issue: h.issue_name, trade: h.trade, score: Math.round((h._score || 0) * 10) / 10 }));
    if (hits.length) {
      return `${base}\n\nRELEVANT KNOWLEDGE (background only, never read out as a list or shown to the customer):\n\n${hits.map(fmtEntry).join('\n\n')}`;
    }
    const trades = [...new Set(rows.map(r => r.trade))].join(', ');
    return `${base}\n\nThe job type is not yet clear. Ask one simple question to find out what is wrong and where in the house. Trades we cover: ${trades || 'plumbing, electrical, carpentry, roofing, appliances, pest control'}.`;
  } catch (error) {
    console.error('Error building AI prompt:', error.message);
    return `${base}\n\n(Knowledge repository unavailable; ask general helpful intake questions.)`;
  }
}

// "I don't know" handling: accept the first, then wrap up kindly instead of frustrating the customer.
const IDK_RE = /\b(i\s*(do\s*not|don'?t|dont)\s*know|dunno|no\s*idea|not\s*sure|unsure|no\s*clue|can'?t\s*say|can'?t\s*tell|couldn'?t\s*say|haven'?t\s*got\s*a\s*clue)\b/i;
const SAFETY_Q_RE = /\b(gas|smoke|smell|spark|burn|shock|flood|sewage|live wire|power ?line|fire)\b/i;
function isDontKnow(text) {
  const t = String(text || '').trim();
  return t.split(/\s+/).length <= 8 && IDK_RE.test(t);
}
// Count "I don't know" answers to ordinary questions. Answers to safety questions are not counted.
function countDontKnows(history) {
  let n = 0, safetyUnknown = false;
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role !== 'user' || !isDontKnow(m.content)) continue;
    const prevAssistant = i > 0 && history[i - 1].role === 'assistant' ? history[i - 1].content : '';
    if (SAFETY_Q_RE.test(prevAssistant)) { if (i === history.length - 1) safetyUnknown = true; continue; }
    n++;
  }
  return { n, safetyUnknown };
}
const IDK_LIMIT = 2;
function idkInstruction(n, safetyUnknown) {
  if (safetyUnknown) {
    return 'The customer said they are not sure about a safety question. Treat "not sure" as possibly yes: gently give the safety advice from your instructions in one or two short sentences (stay clear, and call 000 or the gas emergency line if in doubt), then carry on.';
  }
  if (n >= IDK_LIMIT) {
    return 'The customer has now said they do not know twice. STOP asking questions. Reply in two short, kind sentences: say "That\'s no problem at all" and that someone from the team will contact them to sort out the details. Then tell them to tap the Next button when ready. Do not ask any more questions.';
  }
  if (n === 1) {
    return 'The customer said they do not know. Be soft and a little apologetic. Start with a few reassuring words, then ask ONE different, easier question in this gentle style: "I\'m sorry to ask, but would you happen to know ...?" Keep it to two short sentences. Do not repeat the question they could not answer.';
  }
  return '';
}

// Database initialization
async function initializeDatabase() {
  try {
    await pool.query(`
      -- Tradsmen profiles
      CREATE TABLE IF NOT EXISTS tradsmen (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        phone VARCHAR(20),
        service_type VARCHAR(100),
        logo_url TEXT,
        service_areas TEXT,
        timezone VARCHAR(50),
        tier VARCHAR(20) DEFAULT 'standard',
        stripe_customer_id VARCHAR(255),
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Customer submissions
      CREATE TABLE IF NOT EXISTS submissions (
        id SERIAL PRIMARY KEY,
        customer_id UUID DEFAULT gen_random_uuid(),
        tradsman_id UUID REFERENCES tradsmen(id),
        phone VARCHAR(20),
        email VARCHAR(255),
        address TEXT,
        postcode VARCHAR(10),
        preferred_timeslot TEXT,
        issue_description TEXT,
        issue_location VARCHAR(100),
        issue_severity VARCHAR(20),
        conversation_json TEXT,
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        submitted_at TIMESTAMP,
        email_sent_at TIMESTAMP,
        viewed_by_tradsman BOOLEAN DEFAULT false
      );

      -- Media files
      CREATE TABLE IF NOT EXISTS submission_media (
        id SERIAL PRIMARY KEY,
        submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
        filename VARCHAR(255),
        file_type VARCHAR(50),
        file_url TEXT,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Message history
      CREATE TABLE IF NOT EXISTS message_logs (
        id SERIAL PRIMARY KEY,
        submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
        role VARCHAR(20),
        content TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Which knowledge entries each chat turn matched (shows where knowledge is thin)
      CREATE TABLE IF NOT EXISTS match_log (
        id SERIAL PRIMARY KEY,
        submission_id INTEGER,
        query_text TEXT,
        matched BOOLEAN,
        top_score REAL,
        hits JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Every email we try to send (so nothing is lost if email is not set up yet)
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        submission_id INTEGER,
        kind VARCHAR(30),
        to_email VARCHAR(255),
        subject TEXT,
        urgency VARCHAR(20),
        status VARCHAR(30),
        error TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Text-to-speech cache
      CREATE TABLE IF NOT EXISTS tts_cache (
        id SERIAL PRIMARY KEY,
        text_hash VARCHAR(64) UNIQUE,
        audio_url TEXT,
        duration_seconds INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Knowledge base - common plumbing issues
      CREATE TABLE IF NOT EXISTS knowledge_base (
        id SERIAL PRIMARY KEY,
        issue_name VARCHAR(100) NOT NULL,
        symptoms TEXT NOT NULL,
        causes TEXT NOT NULL,
        emergency_indicators TEXT,
        suggested_questions TEXT,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Reference resources - DIY guides, videos, links
      CREATE TABLE IF NOT EXISTS reference_resources (
        id SERIAL PRIMARY KEY,
        knowledge_base_id INTEGER REFERENCES knowledge_base(id),
        title VARCHAR(255) NOT NULL,
        url TEXT NOT NULL,
        resource_type VARCHAR(50),
        difficulty_level VARCHAR(20),
        estimated_cost VARCHAR(50),
        relevance_score INT,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Admin users
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'admin',
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_submissions_customer_id ON submissions(customer_id);
      CREATE INDEX IF NOT EXISTS idx_submissions_tradsman_id ON submissions(tradsman_id);
      CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
      CREATE INDEX IF NOT EXISTS idx_message_logs_submission_id ON message_logs(submission_id);
      CREATE INDEX IF NOT EXISTS idx_tts_cache_hash ON tts_cache(text_hash);
      CREATE INDEX IF NOT EXISTS idx_knowledge_base_active ON knowledge_base(active);
    `);
    console.log('✓ Database schema initialized');
  } catch (error) {
    console.error('Database initialization error:', error.message);
  }
}

// Seed knowledge base if empty
async function seedKnowledgeBase() {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM knowledge_base');
    if (result.rows[0].count === '0') {
      await pool.query(`
        INSERT INTO knowledge_base (issue_name, symptoms, causes, emergency_indicators, suggested_questions)
        VALUES
          ('Leaking Tap', 'Water dripping from tap, puddles under sink', 'Worn washers, damaged seals, corrosion', 'Water pooling, mold growth', 'How long has it been dripping? Is it hot or cold water? Any discoloration?'),
          ('Blocked Drain', 'Slow drainage, gurgling sounds, water backing up', 'Hair, soap buildup, grease, tree roots', 'Water backing up into other fixtures, foul smell', 'Is it the kitchen, bathroom, or toilet? How long has it been slow? Any bubbling?'),
          ('No Water', 'No water coming out of taps or showerhead', 'Burst pipes, valve issues, main line problems', 'Water pooling outside, no water in entire building', 'Is it just one tap or everywhere? When did it start? Any water on walls?'),
          ('Water Pressure Issues', 'Very low or inconsistent water pressure', 'Mineral buildup, valve issues, pipe corrosion', 'Complete loss of pressure in multiple fixtures', 'Is it hot water, cold water, or both? Affects whole house or one area?'),
          ('Toilet Issues', 'Continuous running, weak flush, water leaking', 'Flapper valve worn, float issues, internal leaks', 'Water continuously running, large puddles', 'Is it running continuously? How often do you need to jiggle the handle?')
      `);
      console.log('✓ Knowledge base seeded');
    }
  } catch (error) {
    console.error('Knowledge base seeding error:', error.message);
  }
}

// Add repository columns and load data/knowledge.json (idempotent, safe to run on every start)
async function importKnowledgeRepository() {
  try {
    await pool.query(`
      ALTER TABLE knowledge_base ALTER COLUMN issue_name TYPE VARCHAR(200);
      ALTER TABLE knowledge_base ALTER COLUMN causes DROP NOT NULL;
      ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS trade VARCHAR(60);
      ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS data JSONB;
      ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS reviewed BOOLEAN DEFAULT false;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_trade_issue ON knowledge_base(trade, issue_name) WHERE trade IS NOT NULL;
    `);
    const file = join(__dirname, 'data', 'knowledge.json');
    if (!existsSync(file)) return;
    const entries = JSON.parse(readFileSync(file, 'utf-8'));
    // Be forgiving: any list-type field written as plain text becomes a list.
    for (const e of entries) {
      for (const k of ['customer_phrases','trigger_keywords','symptoms','likely_causes','emergency_indicators','quote_info_needed','photo_requests','dispatch_tags']) {
        if (typeof e[k] === 'string') e[k] = e[k].split(/[;,]/).map(x => x.trim()).filter(Boolean);
        else if (!Array.isArray(e[k])) e[k] = [];
      }
      if (!Array.isArray(e.questions)) e.questions = [];
    }
    await pool.query(`
      INSERT INTO knowledge_base (issue_name, trade, symptoms, causes, emergency_indicators, suggested_questions, data, reviewed)
      SELECT e->>'issue_name', e->>'trade',
        (SELECT COALESCE(string_agg(x, '; '), '') FROM jsonb_array_elements_text(e->'symptoms') x),
        (SELECT COALESCE(string_agg(x, '; '), '') FROM jsonb_array_elements_text(e->'likely_causes') x),
        (SELECT COALESCE(string_agg(x, '; '), '') FROM jsonb_array_elements_text(e->'emergency_indicators') x),
        (SELECT COALESCE(string_agg(q->>'q', ' '), '') FROM jsonb_array_elements(e->'questions') q),
        e, COALESCE((e->>'reviewed')::boolean, false)
      FROM jsonb_array_elements($1::jsonb) e
      ON CONFLICT (trade, issue_name) WHERE trade IS NOT NULL
      DO UPDATE SET symptoms = EXCLUDED.symptoms, causes = EXCLUDED.causes,
        emergency_indicators = EXCLUDED.emergency_indicators, suggested_questions = EXCLUDED.suggested_questions,
        data = EXCLUDED.data
      WHERE knowledge_base.reviewed = false
    `, [JSON.stringify(entries)]);
    // Retire earlier unreviewed draft rows that the current file no longer contains.
    await pool.query(`
      UPDATE knowledge_base SET active = false
      WHERE trade IS NOT NULL AND reviewed = false
        AND (trade, issue_name) NOT IN (SELECT e->>'trade', e->>'issue_name' FROM jsonb_array_elements($1::jsonb) e)
    `, [JSON.stringify(entries)]);
    // Re-activate rows that are in the file (in case they were retired earlier).
    await pool.query(`
      UPDATE knowledge_base SET active = true
      WHERE trade IS NOT NULL AND reviewed = false
        AND (trade, issue_name) IN (SELECT e->>'trade', e->>'issue_name' FROM jsonb_array_elements($1::jsonb) e)
    `, [JSON.stringify(entries)]);
    kbCache = { at: 0, rows: [] };
    console.log(`Knowledge repository loaded: ${entries.length} entries`);
  } catch (error) {
    console.error('Knowledge repository import error:', error.message);
  }
}

// Seed default admin user if none exist
async function seedAdminUser() {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM admin_users');
    if (result.rows[0].count === '0') {
      const passwordHash = await bcrypt.hash('password123', 10);
      await pool.query(
        `INSERT INTO admin_users (email, password_hash, role, active)
         VALUES ($1, $2, $3, $4)`,
        ['admin@tradies.com', passwordHash, 'admin', true]
      );
      console.log('✓ Admin user seeded');
    }
  } catch (error) {
    console.error('Admin user seeding error:', error.message);
  }
}

// Middleware: Verify JWT token
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ===== CUSTOMER API ENDPOINTS =====

// Start new submission
app.post('/api/v1/submission/start', async (req, res) => {
  try {
    const result = await pool.query(`
      INSERT INTO submissions (status)
      VALUES ('active')
      RETURNING id, customer_id
    `);

    res.json({
      submissionId: result.rows[0].id,
      customerId: result.rows[0].customer_id
    });
  } catch (error) {
    console.error('Submission start error:', error);
    res.status(500).json({ error: 'Failed to start submission' });
  }
});

// Chat with AI (uses knowledge base context)
app.post('/api/v1/chat', async (req, res) => {
  try {
    const { messages, submissionId } = req.body;

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: 'Groq API key not configured' });
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages must be a non-empty array' });
    }

    // Build the history: keep only well-formed turns, then drop any leading
    // assistant turns so the conversation opens on a user turn.
    const clean = messages.filter(
      m => m && (m.role === 'user' || m.role === 'assistant') &&
           typeof m.content === 'string' && m.content.trim()
    );
    const firstUser = clean.findIndex(m => m.role === 'user');
    const history = firstUser === -1 ? [] : clean.slice(firstUser);

    if (history.length === 0 || history[history.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'the last message must have role "user"' });
    }

    // Log user message
    if (submissionId) {
      await pool.query(
        'INSERT INTO message_logs (submission_id, role, content) VALUES ($1, $2, $3)',
        [submissionId, 'user', history[history.length - 1].content]
      );
    }

    // Get AI prompt with knowledge base
    const matchMeta = { hits: [] };
    const queryText = history.filter(m => m.role === 'user').slice(-6).map(m => m.content).join(' ');
    const systemPrompt = await buildAIPrompt(queryText, matchMeta);
    // Record what matched (never blocks or breaks the chat)
    try {
      await withTimeout(pool.query(
        'INSERT INTO match_log (submission_id, query_text, matched, top_score, hits) VALUES ($1,$2,$3,$4,$5)',
        [submissionId || null, queryText.slice(0, 600), matchMeta.hits.length > 0, matchMeta.hits[0]?.score || 0, JSON.stringify(matchMeta.hits)]
      ), 3000, 'match log');
    } catch (e) { console.error('match_log:', e.message); }

    // Groq speaks the OpenAI format: a flat messages array of {role, content},
    // with the knowledge-base grounding carried as a leading system message
    // instead of Gemini's separate systemInstruction field.
    const STYLE = 'STYLE RULES (very important): The customer is often elderly and on a mobile phone. ' +
      'Reply in plain, friendly Australian English using simple everyday words. ' +
      'Ask exactly ONE short question at a time (maximum 2 short sentences in total). ' +
      'Never use lists, bullet points, numbering, markdown, bold text, headings or emojis. ' +
      'Do not diagnose or give repair instructions; just gather useful facts for the tradesperson.';
    const idk = countDontKnows(history);
    const idkNote = idkInstruction(idk.n, idk.safetyUnknown);
    const wrapUp = !idk.safetyUnknown && idk.n >= IDK_LIMIT;
    const groqMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'system', content: STYLE },
      ...(idkNote ? [{ role: 'system', content: idkNote }] : []),
      ...history.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content.trim()
      }))
    ];

    // Cendol pattern preserved: one direct chat completion call, raced against
    // a 25s timeout so we never hit the platform's 30s gateway cutoff.
    const result = await withTimeout(
      groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: groqMessages
      }),
      GROQ_TIMEOUT_MS,
      'Groq chat request'
    );

    const assistantMessage = result.choices?.[0]?.message?.content?.trim();

    if (!assistantMessage) {
      throw new Error('Groq returned an empty completion');
    }

    // Log assistant message
    if (submissionId) {
      await pool.query(
        'INSERT INTO message_logs (submission_id, role, content) VALUES ($1, $2, $3)',
        [submissionId, 'assistant', assistantMessage]
      );
    }

    res.json({
      role: 'assistant',
      content: assistantMessage,
      wrapUp,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Chat error:', error.message || error);

    // Surface the cause the caller can actually act on: bad key, rate limit,
    // retired model, or our own 25s timeout. Everything else stays a 500.
    const status = error.status === 401 || error.status === 403 ? 502
      : error.status === 429 ? 429
      : error.status === 404 ? 502
      : /timed out/.test(error.message || '') ? 504
      : 500;

    res.status(status).json({
      error: 'Failed to process chat',
      details: error.message
    });
  }
});

// Speech-to-text (works on every phone browser; replaces the unreliable Web Speech API)
app.post('/api/v1/transcribe', async (req, res) => {
  try {
    const { audio, mimeType } = req.body || {};
    if (!audio || typeof audio !== 'string') {
      return res.status(400).json({ error: 'audio is required' });
    }
    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: 'Groq API key not configured' });
    }
    const b64 = audio.includes(',') ? audio.split(',')[1] : audio;
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 800) {
      return res.json({ text: '' });
    }
    const type = (mimeType || 'audio/webm').split(';')[0];
    const ext = type.includes('mp4') || type.includes('m4a') ? 'm4a'
      : type.includes('ogg') ? 'ogg'
      : type.includes('wav') ? 'wav'
      : type.includes('mpeg') ? 'mp3'
      : 'webm';
    const file = await toFile(buf, `speech.${ext}`, { type });
    const result = await withTimeout(
      groq.audio.transcriptions.create({
        file,
        model: process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo',
        language: 'en',
        temperature: 0
      }),
      25000,
      'Transcription'
    );
    res.json({ text: (result.text || '').trim() });
  } catch (error) {
    console.error('Transcribe error:', error.message || error);
    res.status(500).json({ error: 'Could not transcribe', details: error.message });
  }
});

// Plain-language summary of the conversation for the customer
app.post('/api/v1/summary', async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages must be a non-empty array' });
    }
    const transcript = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => `${m.role === 'user' ? 'Customer' : 'Assistant'}: ${m.content}`)
      .join('\n')
      .slice(0, 12000);

    const result = await withTimeout(
      groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You write a short summary of a customer\'s home trade problem for an elderly person to read on a phone. ' +
              'Use very simple everyday words and short sentences. Do not diagnose. Do not invent details; if something is unknown say "not said", or "customer not sure" if the customer said they did not know. ' +
              'Reply with ONLY JSON like {"headline":"...","points":[{"label":"The problem","text":"..."},{"label":"Where","text":"..."},{"label":"How long","text":"..."},{"label":"How urgent","text":"..."},{"label":"Photos","text":"..."}]}. ' +
              'Headline: one short sentence. Each text: at most 12 words. Omit a point only if truly nothing is known.'
          },
          { role: 'user', content: transcript }
        ]
      }),
      GROQ_TIMEOUT_MS,
      'Summary'
    );
    const raw = result.choices?.[0]?.message?.content || '';
    let parsed = null;
    try { parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]); } catch (_) { /* fall through */ }
    if (parsed && Array.isArray(parsed.points)) {
      return res.json({ headline: String(parsed.headline || ''), points: parsed.points.slice(0, 6) });
    }
    res.json({ headline: raw.trim().slice(0, 300), points: [] });
  } catch (error) {
    console.error('Summary error:', error.message || error);
    res.status(500).json({ error: 'Could not build summary', details: error.message });
  }
});

// Update submission with customer details
app.post('/api/v1/submission/:id/details', async (req, res) => {
  try {
    const { id } = req.params;
    const { phone, email, address, postcode, preferredTimeslot, tradmanId } = req.body;

    // Validate at least one contact method
    if (!phone && !email) {
      return res.status(400).json({ error: 'Phone or email is required' });
    }

    // Validate postcode if provided (Australian postcodes are 4 digits; no paid geocoding call needed)
    if (postcode && !/^\d{4}$/.test(String(postcode).trim())) {
      return res.status(400).json({ error: 'Invalid postcode' });
    }

    const result = await pool.query(`
      UPDATE submissions
      SET phone = $2, email = $3, address = $4, postcode = $5,
          preferred_timeslot = $6, tradsman_id = $7, status = 'ready_to_submit'
      WHERE id = $1
      RETURNING *
    `, [id, phone, email, address, postcode, preferredTimeslot, tradmanId || null]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Details update error:', error);
    res.status(500).json({ error: 'Failed to update submission details' });
  }
});

// File upload to Spaces
app.post('/api/v1/upload', async (req, res) => {
  try {
    const { file, type, submissionId, filename } = req.body;

    if (!submissionId) {
      return res.status(400).json({ error: 'Submission ID required' });
    }

    const buffer = Buffer.from(file.split(',')[1] || file, 'base64');
    const key = `tradies/${submissionId}/${Date.now()}-${filename}`;

    const uploadParams = {
      Bucket: process.env.DO_SPACES_BUCKET || 'tradies-uploads',
      Key: key,
      Body: buffer,
      ContentType: type || 'application/octet-stream',
      ACL: 'public-read'
    };

    const uploadResult = await s3.upload(uploadParams).promise();

    // Store file reference
    await pool.query(
      'INSERT INTO submission_media (submission_id, filename, file_type, file_url) VALUES ($1, $2, $3, $4)',
      [submissionId, filename, type, uploadResult.Location]
    );

    res.json({
      success: true,
      fileUrl: uploadResult.Location,
      fileId: uploadResult.Key
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// Get relevant resources for submission
app.get('/api/v1/submission/:id/resources', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT rr.* FROM reference_resources rr
      JOIN knowledge_base kb ON rr.knowledge_base_id = kb.id
      WHERE rr.active = true
      ORDER BY rr.relevance_score DESC
      LIMIT 10
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Resource fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch resources' });
  }
});

// Get all active tradsmen
app.get('/api/v1/tradsmen', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, company_name, logo_url, service_type, service_areas
      FROM tradsmen
      WHERE active = true
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Tradsmen fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch tradsmen' });
  }
});

// Submit completed submission (send emails, finalize)

// ---------------------------------------------------------------- notifications
// Email goes out through Resend (https://resend.com). Needs RESEND_API_KEY and MAIL_FROM in Vercel.
// Until then every message is recorded in the notifications table with status "not_configured".
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const URGENCY_RANK = { flexible: 0, this_week: 1, same_day: 2, emergency: 3 };
const URGENCY_LABEL = { emergency: 'URGENT - EMERGENCY', same_day: 'URGENT - SAME DAY', this_week: 'This week', flexible: 'Flexible' };
const EMERGENCY_WORDS = /\b(gas smell|smell(s)? (of )?gas|smoke|sparking|sparks|burning smell|on fire|flood(ing|ed)?|burst|sewage|electric shock|got a shock|live wire|power ?line|no hot water and (a )?baby|fallen tree|tree (on|through)|collapse)/i;

async function assessUrgency(customerText) {
  let level = 'flexible', why = [], issues = [];
  try {
    const rows = await loadKnowledge();
    const hits = pickRelevant(rows, customerText, 3);
    for (const h of hits) {
      issues.push(`${h.issue_name} (${h.trade})`);
      const u = h.urgency_default || 'flexible';
      if ((URGENCY_RANK[u] ?? 0) > URGENCY_RANK[level]) level = u;
      if (u === 'emergency' || u === 'same_day') for (const x of (h.emergency_indicators || []).slice(0, 2)) why.push(x);
    }
  } catch (_) { /* knowledge unavailable: fall back to word check */ }
  const m = String(customerText).match(EMERGENCY_WORDS);
  if (m) { level = 'emergency'; why.unshift(`Customer mentioned "${m[0]}"`); }
  return { level, why: [...new Set(why)].slice(0, 3), issues };
}

async function sendEmail({ to, subject, text, html }) {
  // Option 1: Gmail (or any SMTP) using an app password. Option 2: Resend. Whichever is configured is used.
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    try {
      const nodemailer = (await import('nodemailer')).default;
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT) || 465,
        secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : true,
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
        tls: process.env.SMTP_HOST ? { rejectUnauthorized: false } : undefined,
        connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000
      });
      await withTimeout(transporter.sendMail({
        from: `"Tradies Hotline" <${process.env.GMAIL_USER}>`, to, subject, text, html
      }), 12000, 'Email send');
      return { status: 'sent' };
    } catch (e) { return { status: 'failed', error: String(e.message || e).slice(0, 200) }; }
  }
  if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM) return { status: 'not_configured' };
  try {
    const r = await withTimeout(fetch((process.env.RESEND_API_BASE || 'https://api.resend.com') + '/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text, html })
    }), 8000, 'Email send');
    if (!r.ok) return { status: 'failed', error: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` };
    return { status: 'sent' };
  } catch (e) { return { status: 'failed', error: e.message }; }
}

async function logNotification(subId, kind, to, subject, urgency, result) {
  try {
    await pool.query('INSERT INTO notifications (submission_id, kind, to_email, subject, urgency, status, error) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [subId, kind, to || null, subject, urgency, result.status, result.error || null]);
  } catch (e) { console.error('notification log:', e.message); }
}

function buildTradieEmail(sub, urgency, customerLines, media) {
  const urgent = urgency.level === 'emergency' || urgency.level === 'same_day';
  const label = URGENCY_LABEL[urgency.level];
  const loc = sub.postcode ? ` - ${sub.postcode}` : '';
  const job = urgent && urgency.why[0] ? urgency.why[0] : (urgency.issues[0] ? urgency.issues[0].replace(/\s*\(.*\)$/, '') : 'New job request');
  const subject = `${urgent ? '[URGENT] ' : ''}${job}${loc}`;
  const contact = [
    ['Phone', sub.phone], ['Email', sub.email], ['Address', sub.address], ['Postcode', sub.postcode],
    ['Preferred time', sub.preferred_timeslot]
  ].filter(x => x[1]);
  const lines = [];
  lines.push(urgent ? `*** ${label} - please contact the customer as soon as you can ***` : `Priority: ${label}`);
  if (urgency.why.length) lines.push('Why: ' + urgency.why.join('; '));
  lines.push('', 'CUSTOMER', ...contact.map(([k, v]) => `${k}: ${v}`));
  if (urgency.issues.length) lines.push('', 'Looks like: ' + urgency.issues.join(' / ') + ' (automatic guess, not a diagnosis)');
  lines.push('', 'WHAT THE CUSTOMER TOLD US', ...customerLines.map(l => '- ' + l));
  if (media.length) lines.push('', 'PHOTOS', ...media.map(m => m.file_url));
  lines.push('', `Request #${sub.id}`);
  const text = lines.join('\n');
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px">` +
    (urgent ? `<div style="background:#b00020;color:#fff;padding:12px 16px;font-size:18px;font-weight:bold">${esc(label)} - contact the customer as soon as you can</div>`
            : `<div style="background:#e8f0fe;padding:10px 16px;font-weight:bold">Priority: ${esc(label)}</div>`) +
    (urgency.why.length ? `<p><b>Why:</b> ${esc(urgency.why.join('; '))}</p>` : '') +
    `<h3>Customer</h3><table>${contact.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0"><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('')}</table>` +
    (urgency.issues.length ? `<p><b>Looks like:</b> ${esc(urgency.issues.join(' / '))} <i>(automatic guess, not a diagnosis)</i></p>` : '') +
    `<h3>What the customer told us</h3><ul>${customerLines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` +
    (media.length ? `<h3>Photos</h3><ul>${media.map(m => `<li><a href="${esc(m.file_url)}">${esc(m.filename || 'photo')}</a></li>`).join('')}</ul>` : '') +
    `<p style="color:#666">Request #${esc(sub.id)}</p></div>`;
  return { subject, text, html };
}

app.post('/api/v1/submission/:id/submit', async (req, res) => {
  try {
    const { id } = req.params;

    // Get submission with full details
    const subResult = await pool.query('SELECT * FROM submissions WHERE id = $1', [id]);
    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    const submission = subResult.rows[0];

    // Get messages
    const messagesResult = await pool.query(
      'SELECT role, content FROM message_logs WHERE submission_id = $1 ORDER BY created_at',
      [id]
    );

    // Get media
    const mediaResult = await pool.query(
      'SELECT * FROM submission_media WHERE submission_id = $1',
      [id]
    );

    // Get tradsman info
    let tradsmanEmail = null;
    if (submission.tradsman_id) {
      const tradsmanResult = await pool.query(
        'SELECT email, company_name, logo_url FROM tradsmen WHERE id = $1',
        [submission.tradsman_id]
      );
      if (tradsmanResult.rows.length > 0) {
        tradsmanEmail = tradsmanResult.rows[0].email;
      }
    }

    // Work out urgency and what the customer said (their own words, with "not sure" answers marked)
    const customerLines = messagesResult.rows.filter(m => m.role === 'user').map(m => isDontKnow(m.content) ? `${m.content} (customer not sure)` : m.content);
    const urgency = await assessUrgency(customerLines.join(' '));

    // Who gets it: the chosen tradie, otherwise the admin inbox until assignment rules exist
    let recipient = null, recipientKind = 'tradie';
    if (submission.tradsman_id) {
      const t = await pool.query('SELECT email FROM tradsmen WHERE id = $1', [submission.tradsman_id]);
      recipient = t.rows[0]?.email || null;
    }
    if (!recipient) { recipient = process.env.ADMIN_NOTIFY_EMAIL || process.env.GMAIL_USER || null; recipientKind = 'admin'; }

    const mail = buildTradieEmail(submission, urgency, customerLines, mediaResult.rows);
    let sent = { status: 'no_recipient' };
    if (recipient) sent = await sendEmail({ to: recipient, ...mail });
    await logNotification(id, recipientKind, recipient, mail.subject, urgency.level, sent);

    // Short confirmation to the customer if they gave an email address
    if (submission.email) {
      const c = { subject: 'We have your request', text: `Thanks - we have your request (#${id}) and will pass it on. Someone will contact you soon. If anything is dangerous, such as a gas smell, smoke or water near electrics, call 000 now.` };
      const cs = await sendEmail({ to: submission.email, ...c });
      await logNotification(id, 'customer', submission.email, c.subject, urgency.level, cs);
    }

    await pool.query(
      `UPDATE submissions
       SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP, issue_severity = $2,
           email_sent_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE email_sent_at END
       WHERE id = $1`,
      [id, urgency.level, sent.status === 'sent']
    );

    res.json({
      success: true,
      submissionId: id,
      message: 'Your request has been submitted. The tradsman will contact you soon.',
      urgent: urgency.level === 'emergency' || urgency.level === 'same_day',
      emailSent: sent.status === 'sent'
    });
  } catch (error) {
    console.error('Submission error:', error);
    res.status(500).json({ error: 'Failed to submit' });
  }
});

// ===== ADMIN API ENDPOINTS =====

// Admin login
app.post('/api/v1/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      'SELECT id, email, password_hash, role FROM admin_users WHERE email = $1 AND active = true',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const admin = result.rows[0];
    const validPassword = await bcrypt.compare(password, admin.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: admin.id, email: admin.email, role: admin.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ token, email: admin.email, role: admin.role });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get all tradsmen (admin)
app.get('/api/v1/admin/tradsmen', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tradsmen ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Tradsmen fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch tradsmen' });
  }
});

// Add tradsman (admin)
app.post('/api/v1/admin/tradsmen', verifyToken, async (req, res) => {
  try {
    const { companyName, email, phone, serviceType, logoUrl, serviceAreas, timezone, tier } = req.body;

    const result = await pool.query(`
      INSERT INTO tradsmen (company_name, email, phone, service_type, logo_url, service_areas, timezone, tier)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [companyName, email, phone, serviceType, logoUrl, JSON.stringify(serviceAreas), timezone, tier]);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Tradsman add error:', error);
    res.status(500).json({ error: 'Failed to add tradsman' });
  }
});

// Update tradsman (admin)
app.put('/api/v1/admin/tradsmen/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { companyName, email, phone, serviceType, logoUrl, serviceAreas, timezone, tier } = req.body;

    const result = await pool.query(`
      UPDATE tradsmen
      SET company_name = $2, email = $3, phone = $4, service_type = $5,
          logo_url = $6, service_areas = $7, timezone = $8, tier = $9
      WHERE id = $1
      RETURNING *
    `, [id, companyName, email, phone, serviceType, logoUrl, JSON.stringify(serviceAreas), timezone, tier]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tradsman not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Tradsman update error:', error);
    res.status(500).json({ error: 'Failed to update tradsman' });
  }
});

// Get all submissions (admin dashboard)
app.get('/api/v1/admin/submissions', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, t.company_name
      FROM submissions s
      LEFT JOIN tradsmen t ON s.tradsman_id = t.id
      ORDER BY s.created_at DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Submissions fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
});

// Get submission details with messages (admin)
app.get('/api/v1/admin/submission/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    const submission = await pool.query('SELECT * FROM submissions WHERE id = $1', [id]);
    const messages = await pool.query('SELECT * FROM message_logs WHERE submission_id = $1 ORDER BY created_at', [id]);
    const media = await pool.query('SELECT * FROM submission_media WHERE submission_id = $1', [id]);

    if (submission.rows.length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    res.json({
      submission: submission.rows[0],
      messages: messages.rows,
      media: media.rows
    });
  } catch (error) {
    console.error('Submission detail error:', error);
    res.status(500).json({ error: 'Failed to fetch submission' });
  }
});

// Knowledge base management (admin)
app.get('/api/v1/admin/knowledge-base', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM knowledge_base ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('KB fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch knowledge base' });
  }
});

app.post('/api/v1/admin/knowledge-base', verifyToken, async (req, res) => {
  try {
    const { issueName, symptoms, causes, emergencyIndicators, suggestedQuestions } = req.body;

    const result = await pool.query(`
      INSERT INTO knowledge_base (issue_name, symptoms, causes, emergency_indicators, suggested_questions)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [issueName, symptoms, causes, emergencyIndicators, suggestedQuestions]);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('KB add error:', error);
    res.status(500).json({ error: 'Failed to add knowledge base entry' });
  }
});

// Reference resources management (admin)
app.get('/api/v1/admin/resources', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT rr.*, kb.issue_name
      FROM reference_resources rr
      LEFT JOIN knowledge_base kb ON rr.knowledge_base_id = kb.id
      ORDER BY rr.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Resources fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch resources' });
  }
});

app.post('/api/v1/admin/resources', verifyToken, async (req, res) => {
  try {
    const { kbId, title, url, resourceType, difficultyLevel, estimatedCost, relevanceScore } = req.body;

    const result = await pool.query(`
      INSERT INTO reference_resources (knowledge_base_id, title, url, resource_type, difficulty_level, estimated_cost, relevance_score)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [kbId, title, url, resourceType, difficultyLevel, estimatedCost, relevanceScore]);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Resource add error:', error);
    res.status(500).json({ error: 'Failed to add resource' });
  }
});

// Health check
app.get('/api/v1/health', (req, res) => {
  res.json({
    status: 'ok',
    database: process.env.DATABASE_URL ? 'configured' : 'not configured',
    groq: process.env.GROQ_API_KEY ? 'configured' : 'not configured',
    spaces: process.env.DO_SPACES_BUCKET ? 'configured' : 'not configured'
  });
});

app.get('/api/v1/admin/notifications', verifyToken, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Where the knowledge is thin: chats that matched nothing, or only weakly (admin only)
app.get('/api/v1/admin/match-gaps', verifyToken, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const sum = await pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE matched)::int AS matched,
      COUNT(*) FILTER (WHERE NOT matched)::int AS unmatched,
      COUNT(*) FILTER (WHERE matched AND top_score < 8)::int AS weak
      FROM match_log WHERE created_at > NOW() - ($1 || ' days')::interval`, [days]);
    const un = await pool.query(`SELECT query_text, top_score, created_at FROM match_log
      WHERE NOT matched AND created_at > NOW() - ($1 || ' days')::interval ORDER BY created_at DESC LIMIT 100`, [days]);
    const weak = await pool.query(`SELECT query_text, top_score, hits, created_at FROM match_log
      WHERE matched AND top_score < 8 AND created_at > NOW() - ($1 || ' days')::interval ORDER BY created_at DESC LIMIT 100`, [days]);
    const top = await pool.query(`SELECT h->>'issue' AS issue, h->>'trade' AS trade, COUNT(*)::int AS times
      FROM match_log, jsonb_array_elements(hits) h WHERE created_at > NOW() - ($1 || ' days')::interval
      GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20`, [days]);
    res.json({ days, summary: sum.rows[0], unmatched: un.rows, weak: weak.rows, topMatches: top.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Does this database support smarter (fuzzy / semantic) search? Reports availability only.
app.get('/api/v1/health/db-extensions', async (req, res) => {
  try {
    const r = await pool.query("SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name IN ('vector','pg_trgm','fuzzystrmatch','unaccent') ORDER BY name");
    const v = await pool.query('SHOW server_version');
    res.json({ server_version: v.rows[0].server_version, extensions: r.rows });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

// Repository size by trade (public, counts only)
app.get('/api/v1/knowledge/stats', async (req, res) => {
  try {
    const r = await pool.query("SELECT COALESCE(trade,'(legacy)') AS trade, COUNT(*)::int AS entries, SUM(jsonb_array_length(COALESCE(data->'questions','[]'::jsonb)))::int AS questions FROM knowledge_base WHERE active = true GROUP BY 1 ORDER BY 2 DESC");
    res.json({ total: r.rows.reduce((a, x) => a + x.entries, 0), byTrade: r.rows });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

// DB health: surfaces the real connection error (message only) for diagnosis.
app.get('/api/v1/health/db', async (req, res) => {
  try {
    const r = await pool.query('SELECT COUNT(*)::int AS admins FROM admin_users');
    res.json({ ok: true, admins: r.rows[0].admins });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message, code: e.code });
  }
});

// Deep health check: actually exercises the Groq credential instead of only
// asserting the env var is non-empty. Use this to tell "key missing" from
// "key invalid" from "model unavailable".
async function groqHealth(req, res) {
  if (!process.env.GROQ_API_KEY) {
    return res.status(503).json({ ok: false, reason: 'GROQ_API_KEY not set' });
  }

  try {
    // Cheapest possible real call against the pinned model: proves the key works
    // and the model is reachable, without any catalogue lookup.
    const result = await withTimeout(
      groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
        // Reasoning-capable models spend part of the budget on hidden reasoning
        // tokens, so too small a cap returns an empty content string.
        max_tokens: 256
      }),
      GROQ_TIMEOUT_MS,
      'Groq health check'
    );

    res.json({
      ok: true,
      model: GROQ_MODEL,
      keyValid: true,
      sample: (result.choices?.[0]?.message?.content || '').slice(0, 80)
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      model: GROQ_MODEL,
      keyValid: !(error.status === 401 || error.status === 403 ||
                  /invalid_api_key|Invalid API Key|401|403/.test(error.message || '')),
      reason: error.message
    });
  }
}

app.get('/api/v1/health/groq', groqHealth);
// Back-compat alias so anything already probing the old path keeps working.
app.get('/api/v1/health/gemini', groqHealth);

// Initialize and start.
// On Vercel the platform invokes the exported Express app per request (no
// listen()), so DB init runs once, lazily, before the first API request.
let initPromise = null;
function ensureInitialized() {
  if (!initPromise) {
    initPromise = (async () => {
      await initializeDatabase();
      await seedKnowledgeBase();
      await importKnowledgeRepository();
      await seedAdminUser();
    })().catch((err) => {
      console.error('Startup init failed:', err);
      initPromise = null; // allow retry on next request
    });
  }
  return initPromise;
}

if (!process.env.VERCEL) {
  ensureInitialized().then(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`Tradies Hotline API running on http://localhost:${PORT}`);
    });
  });
}

export default app;
