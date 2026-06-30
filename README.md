# Jungle

Slack-style app for chatting with cloud agents that do real work.

## Prerequisites

- Node.js 18+
- Docker Desktop (for local Postgres via `npm run db:up`)
- Anthropic API key (for cloud agents)

## First-time setup

```bash
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL and ANTHROPIC_API_KEY

npm run setup        # install deps, start Postgres, apply schema
npm run setup:agents # optional — bootstrap Anthropic Managed Agents (.jungle-ids.json)
```

## Daily dev

```bash
npm run dev          # backend (:3001) + frontend (:5173)
```

Or run them separately:

```bash
npm run dev:backend
npm run dev:frontend
```

Open http://localhost:5173 — the sign-in screen lets you pick or create a participant.

## Database

| Command | Description |
|---------|-------------|
| `npm run db:up` | Start Postgres in Docker (persistent volume `jungle-postgres-data`) |
| `npm run db:migrate` | Apply `backend/db/schema.sql` |
| `npm run db:down` | Stop/remove the container (volume is kept) |

If `DATABASE_URL` points at a remote host (not localhost), `db:up` is a no-op and `db:migrate` uses `psql` on your PATH.

## Verification scripts

Step tests live in `backend/test/` and `scripts/`. Most need the backend running and env loaded:

```bash
set -a; . .env; set +a
node backend/test/step3.mjs
```

## Ports

| Service | URL |
|---------|-----|
| Frontend | http://localhost:5173 |
| Backend | http://localhost:3001 |
