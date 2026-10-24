# VoteHub voting platform

Single-package app. See README.md.

- Run: `npm install && npm run dev` (one process: API + web on PORT, default 3000)
- Production: `npm run build && npm start`
- Database: PostgreSQL via DATABASE_URL (database is created automatically if missing)
- Payments: Paystack (Flutterwave optional, Test mode for development)
