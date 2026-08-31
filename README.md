# Tradies Hotline

This prototype has a PostgreSQL production persistence path for businesses, customers, requests, messages, request state, and knowledge documents/chunks. Without `DATABASE_URL`, non-production development uses in-memory repositories only; data is lost on restart.

## Run locally

1. Copy `.env.example` to `.env`.
2. Set `DATABASE_URL` to a PostgreSQL database and run `npm install`.
3. Run `npm run migrate`, then `npm run seed`.
4. Set `BUSINESS_ID` and `PUBLIC_BUSINESS_ID` to the seeded business ID, and set `OWNER_AUTH_TOKENS` to a JSON object mapping a long random owner token to that ID.
5. Run `npm run dev`.

## Database

`db/migrations/` is the schema source of truth. `npm run migrate` records applied migrations in `schema_migrations`. `npm run seed` creates development business `00000000-0000-4000-8000-000000000001`.

Use a separate database for integration tests and set `TEST_DATABASE_URL`. Run `npm run test:db` to execute PostgreSQL integration tests.

## Test

`npm test`
