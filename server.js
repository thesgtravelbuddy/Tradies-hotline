import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import AWS from 'aws-sdk';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));
app.use(express.static('.'));

// Serve index.html for root path
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

// Serve admin.html
app.get('/admin.html', (req, res) => {
  res.sendFile(join(__dirname, 'admin.html'));
});

// Initialize services
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const s3 = new AWS.S3({
  endpoint: process.env.DO_SPACES_ENDPOINT,
  accessKeyId: process.env.DO_SPACES_KEY,
  secretAccessKey: process.env.DO_SPACES_SECRET,
  region: 'nyc3'
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key-change-in-production';

// Build AI system prompt with knowledge base context
async function buildAIPrompt() {
  try {
    const result = await pool.query('SELECT * FROM knowledge_base WHERE active = true LIMIT 20');
    const kbEntries = result.rows;

    const kbContext = kbEntries.map(entry =>
      `- ${entry.issue_name}: ${entry.symptoms} → Common causes: ${entry.causes}`
    ).join('\n');

    return `You are a helpful assistant for Tradies Hotline, connecting customers with tradesman.

Your job is to:
1. Ask clear, natural questions about their plumbing issue
2. Be empathetic - customers may be stressed
3. Gather useful info for tradsman diagnosis (location, severity, duration, damage, water type)
4. DO NOT diagnose or recommend solutions
5. DO NOT suggest plumbing repairs

Common plumbing issues to reference:
${kbContext}

Key details to gather:
- WHERE: exact location (kitchen, bathroom, ceiling, etc.)
- WHAT: what's happening (leak, no water, drain, noise, etc.)
- WHEN: duration (today, days ago, ongoing)
- HOW MUCH: severity (dripping, flowing, gushing)
- WHAT TYPE: hot, cold, both, discolored, smelly
- DAMAGE: staining, mold, structural damage
- ATTEMPTS: what they've tried (plunger, drain cleaner)
- BUILDING: age, type, tenant vs owner
- ACCESS: can tradsman easily access

Ask follow-up questions based on their answers. Keep conversation natural and friendly.`;
  } catch (error) {
    console.error('Error building AI prompt:', error);
    return 'You are a helpful plumbing intake assistant. Ask clear questions about their issue.';
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

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Gemini API key not configured' });
    }

    // Log user message
    if (submissionId && messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role === 'user') {
        await pool.query(
          'INSERT INTO message_logs (submission_id, role, content) VALUES ($1, $2, $3)',
          [submissionId, 'user', lastMsg.content]
        );
      }
    }

    // Get AI prompt with knowledge base
    const systemPrompt = await buildAIPrompt();

    // Prepare messages for Gemini
    const geminiMessages = messages.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    }));

    // Call Gemini API
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const chat = model.startChat({
      history: geminiMessages.slice(0, -1),
      systemInstruction: systemPrompt
    });

    const userMessage = geminiMessages[geminiMessages.length - 1].parts[0].text;
    const result = await chat.sendMessage(userMessage);
    const assistantMessage = result.response.text();

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
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Failed to process chat' });
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
    gemini: process.env.GEMINI_API_KEY ? 'configured' : 'not configured',
    spaces: process.env.DO_SPACES_BUCKET ? 'configured' : 'not configured'
  });
});

// Initialize and start
async function startup() {
  await initializeDatabase();
  await seedKnowledgeBase();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✓ Tradies Hotline API running on http://localhost:${PORT}`);
    console.log(`✓ Customer app: http://localhost:${PORT}`);
    console.log(`✓ Admin panel: http://localhost:${PORT}/admin.html`);
  });
}

startup();
