# Alumni Elections

A non-production election-management prototype for alumni associations, built around fictional sample records and read-only ballot previews.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/alumni-elections run dev` — run the web application
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/alumni-elections/` — admin and voter-preview web app
- `artifacts/api-server/src/routes/elections.ts` — demo election API
- `lib/api-spec/openapi.yaml` — API source of truth; regenerate clients after edits
- `lib/db/src/schema/` — Drizzle schema
- `artifacts/alumni-elections/SECURITY_SCOPE.md` — prototype threat boundary and limitations

## Architecture decisions

- This build is explicitly a fictional, non-production demonstration; it does not implement ballots or tallying.
- Demo API writes are available in development only and are rejected in production.
- The app represents one fixed sample organization; it does not implement sign-in, role enforcement, or tenant isolation.
- Activity history is operational sample data, not a tamper-evident election audit log.

## Product

The app demonstrates election administration, draft creation and lifecycle updates, candidate review, member-eligibility review, activity history, and a read-only ballot preview.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Never import real member data or use this prototype to conduct or certify an election.
- The production API intentionally blocks demo mutations; no account authentication is wired.
- The attached development prompt ended partway through its database-design section; later requirements may still be missing.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
