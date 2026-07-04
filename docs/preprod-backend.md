# Preprod backend (isolated)

A second, **fully isolated** backend instance runs on the same EC2 box so the `feat/workspaces`
(multi-tenant workspaces) branch can be tested end-to-end on preprod **without touching prod**.

## Topology

| | Prod | Preprod |
|---|---|---|
| Frontend (Vercel) | `www.jungleagents.com` (branch `main`) | `preprod.jungleagents.com` (branch `preprod`) |
| Backend public URL | `https://api.jungleagents.com` | `https://preprod-api.52.87.26.31.sslip.io` |
| Backend port (localhost) | 3001 | 3002 |
| systemd unit | `jungle-backend` | `jungle-backend-preprod` |
| Working dir / branch | `~/dev/jungle` (main) | `~/dev/jungle-workspaces` (worktree, `feat/workspaces`) |
| Database (local Postgres) | `jungle` | `jungle_preprod` |
| Env file | `~/dev/jungle/.env` | `~/dev/jungle-workspaces/.env.preprod` |
| Runner provider | Fly | Fly (same app; agent ids are unique per-DB, so no collision) |
| Auth | Firebase (real) | Firebase (real; `AUTH_DEV_BYPASS=0`) |

`preprod-api.52.87.26.31.sslip.io` is an [sslip.io](https://sslip.io) hostname that resolves to this
box's public IP (`52.87.26.31`) with no DNS setup; Caddy terminates TLS for it (block appended to
`/etc/caddy/Caddyfile`, reverse-proxying `localhost:3002`).

The preprod env file is a copy of prod's `.env` with the environment-specific keys overridden
(`DATABASE_URL`→`jungle_preprod`, `PORT=3002`, `FRONTEND_URL`→preprod, `RUNNER_BACKEND_WS`→preprod
wss, `GITHUB_REDIRECT_URI`→preprod, `MAX_AGENTS_PER_WORKSPACE=5`). All secrets (Firebase, Anthropic,
Fly, GitHub) are shared with prod.

## Operating it

```bash
sudo systemctl {status|restart|stop} jungle-backend-preprod
sudo journalctl -u jungle-backend-preprod -f
curl -s https://preprod-api.52.87.26.31.sslip.io/health

# Redeploy backend code after new commits on feat/workspaces:
cd ~/dev/jungle-workspaces && git pull        # (worktree tracks feat/workspaces)
sudo systemctl restart jungle-backend-preprod

# DB migrations for preprod:
psql "$(grep ^DATABASE_URL ~/dev/jungle-workspaces/.env.preprod | cut -d= -f2-)" -f backend/migrations/<file>.sql
```

## Frontend wiring (Vercel)

The preprod frontend must point at the preprod backend. Set these on the Vercel project for the
**Preview / preprod** environment (they must NOT change the Production/`main` values):

- `VITE_API_URL = https://preprod-api.52.87.26.31.sslip.io`
- `VITE_WS_URL  = wss://preprod-api.52.87.26.31.sslip.io`

Then redeploy the `preprod` branch. _(Configured 2026-07-04.)_

## Notes / caveats

- Prod is completely untouched: separate service, port, DB, and Caddy host.
- GitHub connect on preprod redirects to the preprod callback
  (`https://preprod-api.52.87.26.31.sslip.io/auth/github/callback`); that URL must be registered in
  the GitHub App for GitHub features to work on preprod. GitHub is skippable, so core workspace
  testing works without it.
- Prod and preprod share the Fly app + Anthropic key, so preprod agent turns incur real cost
  (idle-stop still applies).
