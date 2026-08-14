# Tradies Hotline

Phase 1 provides a mobile customer intake form, a small owner dashboard, and JSON API backed by PostgreSQL when `DATABASE_URL` is configured. Local development uses an in-memory repository so the application can be explored without credentials.

## Run locally

1. Copy `.env.example` to `.env` and set values if required.
2. Run `npm install`.
3. Run `npm run dev`.
4. Open `http://localhost:3000` (customer) or `http://localhost:3000/owner` (owner dashboard).

## Database

Execute `db/schema.sql` against PostgreSQL before setting `DATABASE_URL`. The schema is deliberately independent of the future knowledge retrieval and AI provider layers.

## Test

`npm test`
