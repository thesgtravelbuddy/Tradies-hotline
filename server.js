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
  return scored.filter(x => x.score >= top * 0.6).map(x => x.e);
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
async function buildAIPrompt(conversationText = '') {
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
    const systemPrompt = await buildAIPrompt(history.filter(m => m.role === 'user').slice(-6).map(m => m.content).join(' '));

    // Groq speaks the OpenAI format: a flat messages array of {role, content},
    // with the knowledge-base grounding carried as a leading system message
    // instead of Gemini's separate systemInstruction field.
    const STYLE = 'STYLE RULES (very important): The customer is often elderly and on a mobile phone. ' +
      'Reply in plain, friendly Australian English using simple everyday words. ' +
      'Ask exactly ONE short question at a time (maximum 2 short sentences in total). ' +
      'Never use lists, bullet points, numbering, markdown, bold text, headings or emojis. ' +
      'Do not diagnose or give repair instructions; just gather useful facts for the tradesperson.';
    const groqMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'system', content: STYLE },
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
              'Use very simple everyday words and short sentences. Do not diagnose. Do not invent details; if something is unknown say "not said". ' +
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

    // Validate postcode if provided
    if (postcode) {
      try {
        const mapResponse = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
          params: {
            address: `${postcode} AU`,
            key: process.env.GOOGLE_MAPS_API_KEY
          }
        });
        if (!mapResponse.data.results.length) {
          return res.status(400).json({ error: 'Invalid postcode' });
        }
      } catch (err) {
        console.error('Postcode validation error:', err.message);
      }
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

    // TODO: Send emails via Zoho Mail
    // 1. Customer confirmation email with tradsman branding
    // 2. Tradsman notification with full details

    // Update submission status
    await pool.query(
      `UPDATE submissions
       SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP, email_sent_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [id]
    );

    res.json({
      success: true,
      submissionId: id,
      message: 'Your request has been submitted. The tradsman will contact you soon.',
      emailSent: tradsmanEmail ? true : false
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
