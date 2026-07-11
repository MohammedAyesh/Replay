# Replay

A mobile-first web app where amateur soccer players browse pre-recorded footage from local soccer fields, watch a TikTok-style highlights feed, and save their best moments as clips.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/soccerwatch run dev` — run the frontend (port 20097)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite, Tailwind CSS, Space Grotesk font, Framer Motion
- API: Express 5, cookie-based session auth
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — API contract (source of truth)
- `lib/db/src/schema/` — Drizzle table definitions (users, fields, recordings, clips, savedClips, likes)
- `artifacts/api-server/src/routes/` — Express route handlers (auth, fields, recordings, clips, savedClips, account)
- `artifacts/soccerwatch/src/` — React frontend (pages: login, watch, fields, field detail, player, my-clips, account)

## Architecture decisions

- Auth via `userId` cookie (httpOnly, sameSite=lax) — simple session; no JWT
- Guest users are real DB rows (is_guest=true) with auto-generated emails
- Like counts are denormalized on the `clips` table for fast reads
- Query params removed from OpenAPI spec to avoid Orval `*Params` type collisions between `api.ts` and `types/` barrel
- OpenAPI body schemas use entity-shaped names (e.g. `LoginInput`) not operation-shaped (`LoginBody`) to avoid TS2308 collisions

## Product

- **Login** — dark navy hero with field-pattern background, Replay logo, orange CTA, email login + guest option
- **Watch** — full-screen TikTok-style scroll-snap clip feed, ranked by likes, with like/save/share actions
- **Fields** — searchable list of local soccer fields with clip counts; tap to see recordings
- **Player** — immersive single-clip view with like/save action bar
- **My Clips** — 2-column grid of saved highlights
- **Account** — profile, stats (saved clips, likes given, fields visited), settings

## Demo accounts

- `alex@soccerwatch.com` / `demo`
- `sam@soccerwatch.com` / `demo`

## Gotchas

- Orval generates `<OperationIdPascal>Params` in both `api.ts` (Zod) and `types/` (TS). Operations with query params cause a TS2308 collision in `lib/api-zod`. Keep query params out of the OpenAPI spec — filter client-side instead.
- Run `pnpm --filter @workspace/api-spec run codegen` after every OpenAPI spec change before touching backend or frontend types.
- Frontend uses `@/lib/utils` for `cn()` — not `./utils`.
- Cookie credentials require `cors({ origin: true, credentials: true })` in app.ts.
