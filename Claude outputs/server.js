import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import AWS from 'aws-sdk';
import Stripe from 'stripe';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));
app.use(express.static('public'));

// Initialize services
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Digital Ocean Spaces S3 configuration
const s3 = new AWS.S3({
  endpoint: process.env.DO_SPACES_ENDPOINT,
  accessKeyId: process.env.DO_SPACES_KEY,
  secretAccessKey: process.env.DO_SPACES_SECRET,
  region: 'nyc3'
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

// System prompt for AI conversation
const TRADIES_HOTLINE_SYSTEM = `You are a helpful assistant for Tradies Hotline, a service connecting customers with tradesman.

Your ONLY job is to:
1. Ask clear, natural questions to understand the customer's issue
2. Be empathetic - customers may be stressed about problems
3. Gather information useful for a tradesman to diagnose and act
4. DO NOT diagnose or fix problems yourself
5. DO NOT recommend specific solutions

For plumbing issues, important details include:
- WHERE: exact location (kitchen sink, bathroom, ceiling, outside, etc.)
- WHAT: what's happening (leak, no water, slow drain, noise, flooding, etc.)
- WHEN: duration (just started, ongoing, days ago)
- HOW MUCH: severity (dripping, flowing, gushing, pooling)
- WHAT TYPE: hot, cold, both, discolored, smelly
- DAMAGE: staining, mold, structural damage, wet walls
- ATTEMPTS: what they've tried (plunger, drain cleaner, etc.)
- BUILDING: age, type (apartment/house), tenant vs owner
- ACCESS: can tradesman easily access the area

Keep conversation natural and friendly. Ask follow-up questions based on their answers.
When you have gathered key information (location, issue type, severity), ask about contact details.
Only gather: phone OR email (at least one required), address (optional), preferred timeslot (optional).`;

// Database initialization
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        customer_id UUID DEFAULT gen_random_uuid(),
        phone VARCHAR(20),
        email VARCHAR(255),
        address TEXT,
        postcode VARCHAR(10),
        preferred_timeslot TEXT,
        issue_description TEXT,
        issue_location TEXT,
        issue_severity VARCHAR(20),
        tradesman_id UUID,
        tier VARCHAR(20) DEFAULT 'standard',
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        email_sent_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS files (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER REFERENCES conversations(id),
        filename VARCHAR(255),
        file_type VARCHAR(50),
        file_url TEXT,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS message_logs (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER REFERENCES conversations(id),
        role VARCHAR(20),
        content TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tradesman (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        phone VARCHAR(20),
        service_type VARCHAR(100),
        logo_url TEXT,
        timezone VARCHAR(50),
        tier VARCHAR(20) DEFAULT 'standard',
        stripe_customer_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_customer_id ON conversations(customer_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_tradesman_id ON conversations(tradesman_id);
      CREATE INDEX IF NOT EXISTS idx_message_logs_conversation_id ON message_logs(conversation_id);
    `);
    console.log('✓ Database initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Postcode validation via Google Maps
async function validatePostcode(postcode, country = 'AU') {
  try {
    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        address: `${postcode} ${country}`,
        key: process.env.GOOGLE_MAPS_API_KEY
      }
    });
    return response.data.results && response.data.results.length > 0;
  } catch (error) {
    console.error('Postcode validation error:', error);
    return null;
  }
}

// Gemini conversation endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, conversationId } = req.body;

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Gemini API key not configured' });
    }

    // Log user message
    if (conversationId && messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role === 'user') {
        await pool.query(
          'INSERT INTO message_logs (conversation_id, role, content) VALUES ($1, $2, $3)',
          [conversationId, 'user', lastMsg.content]
        );
      }
    }

    // Prepare messages for Gemini
    const geminiMessages = messages.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    }));

    // Call Gemini API
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const chat = model.startChat({
      history: geminiMessages.slice(0, -1),
      systemInstruction: TRADIES_HOTLINE_SYSTEM
    });

    const userMessage = geminiMessages[geminiMessages.length - 1].parts[0].text;
    const result = await chat.sendMessage(userMessage);
    const assistantMessage = result.response.text();

    // Log assistant message
    if (conversationId) {
      await pool.query(
        'INSERT INTO message_logs (conversation_id, role, content) VALUES ($1, $2, $3)',
        [conversationId, 'assistant', assistantMessage]
      );
    }

    res.json({
      role: 'assistant',
      content: assistantMessage,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Failed to process chat', details: error.message });
  }
});

// Create or get conversation
app.post('/api/conversation/start', async (req, res) => {
  try {
    const { trademanId } = req.body;

    const result = await pool.query(
      `INSERT INTO conversations (tradesman_id)
       VALUES ($1)
       RETURNING id, customer_id`,
      [trademanId || null]
    );

    res.json({
      conversationId: result.rows[0].id,
      customerId: result.rows[0].customer_id
    });
  } catch (error) {
    console.error('Conversation start error:', error);
    res.status(500).json({ error: 'Failed to start conversation' });
  }
});

// Update conversation with customer details
app.post('/api/conversation/:id/details', async (req, res) => {
  try {
    const { id } = req.params;
    const { phone, email, address, postcode, preferredTimeslot } = req.body;

    // Validate at least one contact method
    if (!phone && !email) {
      return res.status(400).json({ error: 'Phone or email is required' });
    }

    // Validate postcode if provided
    if (postcode) {
      const isValid = await validatePostcode(postcode);
      if (isValid === false) {
        return res.status(400).json({ error: 'Invalid postcode' });
      }
    }

    const result = await pool.query(
      `UPDATE conversations
       SET phone = $2, email = $3, address = $4, postcode = $5, preferred_timeslot = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id, phone, email, address, postcode, preferredTimeslot]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Details update error:', error);
    res.status(500).json({ error: 'Failed to update conversation details' });
  }
});

// File upload endpoint
app.post('/api/upload', async (req, res) => {
  try {
    const { file, type, conversationId, filename } = req.body;

    if (!conversationId) {
      return res.status(400).json({ error: 'Conversation ID required' });
    }

    // Decode base64 file
    const buffer = Buffer.from(file.split(',')[1] || file, 'base64');
    const key = `tradies/${conversationId}/${Date.now()}-${filename}`;

    // Upload to Digital Ocean Spaces
    const uploadParams = {
      Bucket: process.env.DO_SPACES_BUCKET || 'tradies-uploads',
      Key: key,
      Body: buffer,
      ContentType: type || 'application/octet-stream',
      ACL: 'public-read'
    };

    const uploadResult = await s3.upload(uploadParams).promise();

    // Store file reference in database
    await pool.query(
      'INSERT INTO files (conversation_id, filename, file_type, file_url) VALUES ($1, $2, $3, $4)',
      [conversationId, filename, type, uploadResult.Location]
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

// Send email via Zoho Mail API (placeholder - requires Zoho configuration)
async function sendTradieEmail(conversation, files) {
  try {
    if (!process.env.ZOHO_MAIL_API_KEY) {
      console.log('Zoho Mail not configured - email not sent');
      return null;
    }

    // Build email content
    const issueDetails = `
Phone: ${conversation.phone || 'N/A'}
Email: ${conversation.email || 'N/A'}
Address: ${conversation.address || 'N/A'}
Postcode: ${conversation.postcode || 'N/A'}
Preferred Timeslot: ${conversation.preferred_timeslot || 'N/A'}

Issue: ${conversation.issue_description || 'See conversation'}
Location: ${conversation.issue_location || 'N/A'}
Severity: ${conversation.issue_severity || 'N/A'}
    `;

    const fileLinks = files.map(f => `${f.filename}: ${f.file_url}`).join('\n');

    const emailBody = `New plumbing request from Tradies Hotline:\n\n${issueDetails}\n\nAttachments:\n${fileLinks || 'None'}`;

    // TODO: Integrate with Zoho Mail API
    // For now, just log that email would be sent
    console.log(`Email would be sent to tradesman - Tier: ${conversation.tier}`);

    // Mark email as sent
    await pool.query(
      'UPDATE conversations SET email_sent_at = CURRENT_TIMESTAMP WHERE id = $1',
      [conversation.id]
    );

    return { success: true, scheduled: conversation.tier === 'standard' };
  } catch (error) {
    console.error('Email send error:', error);
    return null;
  }
}

// Complete conversation and send to tradesman
app.post('/api/conversation/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;

    // Get conversation details
    const convResult = await pool.query('SELECT * FROM conversations WHERE id = $1', [id]);
    if (convResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const conversation = convResult.rows[0];

    // Get conversation messages
    const messagesResult = await pool.query(
      'SELECT * FROM message_logs WHERE conversation_id = $1 ORDER BY created_at',
      [id]
    );

    // Get files
    const filesResult = await pool.query(
      'SELECT * FROM files WHERE conversation_id = $1',
      [id]
    );

    // Send to tradesman
    const emailResult = await sendTradieEmail(conversation, filesResult.rows);

    // Update conversation status
    await pool.query(
      'UPDATE conversations SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id, 'submitted']
    );

    res.json({
      success: true,
      conversationId: id,
      emailScheduled: emailResult?.scheduled || false,
      message: conversation.tier === 'standard'
        ? 'Your request has been submitted. The tradesman will receive it at 4pm.'
        : 'Your request has been submitted and sent to the tradesman immediately.'
    });
  } catch (error) {
    console.error('Completion error:', error);
    res.status(500).json({ error: 'Failed to complete conversation' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Tradies Voice App is running' });
});

// Serve static files
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Initialize database and start server
initializeDatabase();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Tradies Voice App running on http://localhost:${PORT}`);
  console.log(`✓ Gemini API: ${process.env.GEMINI_API_KEY ? 'configured' : 'NOT configured'}`);
  console.log(`✓ Database: ${process.env.DATABASE_URL ? 'configured' : 'NOT configured'}`);
  console.log(`✓ Digital Ocean Spaces: ${process.env.DO_SPACES_BUCKET ? 'configured' : 'NOT configured'}`);
});
