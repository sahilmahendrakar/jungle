# The Slack agent app (@jungle in Slack)

`@jungle` — the workspace's default agent (`backend/src/services/jungleAgent.ts`) — reachable as a
real Slack DM. Describe a job in plain words and it creates the agent, workflow or schedule that
does it, using the `jungle-admin` tools it already has.

This is a **second Slack app**, separate from the channel-mirror app in `http/routes/slack.ts`.

## Why two apps

Slack's `features.agent_view` (the agent DM experience: messages tab, in-thread replies, suggested
prompts) is a **one-way switch that applies to every user of the app**. Turning it on for the live
mirroring app could not be undone, so the agent experience gets its own app and channel mirroring
keeps working exactly as before.

One Slack app also exposes exactly one agent identity — `features.bot_user` and `features.agent_view`
are objects in the manifest schema, not arrays. Per-agent Slack identities therefore mean per-agent
apps, which is Phase 2 (`apps.manifest.create`), not this.

## How it fits together

```
Slack IM "D…"  <->  slack_channel_links row  <->  Jungle DM channel (person <-> @jungle)
                    (install_kind='agent',
                     dm_agent_id=@jungle)
```

Modelling the DM as an ordinary link row is the whole trick: ingress and the entire transactional
outbox already understand link rows, so DMs work with no new egress code, and the Slack DM and the
web DM are **the same conversation** — same channel, same session, same memory.

`slack_installs` is keyed `(workspace_id, kind)` so one workspace holds both installs, and
`claimDueOutbox` joins on `i.kind = l.install_kind` so a DM reply is posted with the agent app's
token rather than the mirror's.

**No message streaming.** The runner emits a *complete* message via `send_message`
(`shared/src/runner-protocol.ts`), so there is no token delta to feed `chat.appendStream`. Liveness
is `assistant.threads.setStatus` while the turn runs.

## Manual setup (once per deployment)

1. **Create the app** at <https://api.slack.com/apps> → *From an app manifest* → pick the workspace
   → paste the manifest below. Replace `api.jungleagents.com` if your backend is elsewhere.
2. **Enable the agent experience**: *Features → Agents & AI Apps → Agent or Assistant* → on.
   ⚠️ Irreversible for that app. Do it on a throwaway app first if you want to look around.
3. **Install to the workspace** (*Install App*), then copy from *Basic Information*:
   - Client ID → `SLACK_AGENT_CLIENT_ID`
   - Client Secret → `SLACK_AGENT_CLIENT_SECRET`
   - Signing Secret → `SLACK_AGENT_SIGNING_SECRET`
4. Put those three in the backend `.env` and `sudo systemctl restart jungle-backend`.
5. **Connect the workspace**: `POST /api/slack/agent/install-url` as an admin, open the returned
   URL, approve. That writes the `kind='agent'` install row.
6. DM the app in Slack. The first message binds the DM and wakes `@jungle`.

Until step 4 the feature is inert: the webhook rejects unsigned events (401) and
`/api/slack/agent/install-url` returns 500 "not configured". Nothing else changes.

## Manifest

```json
{
  "display_information": {
    "name": "Jungle",
    "description": "Describe what you want done. I build the agents and workflows that do it.",
    "background_color": "#1d3b2a"
  },
  "features": {
    "bot_user": { "display_name": "Jungle", "always_online": true },
    "app_home": {
      "home_tab_enabled": true,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "agent_view": {
      "agent_description": "I build agents and workflows that do real work.",
      "suggested_prompts": [
        { "title": "Watch our Linear backlog", "message": "Watch our Linear backlog and file bugs as GitHub issues." },
        { "title": "Summarize #eng each morning", "message": "Every weekday at 9am, summarize what shipped and post it in #eng." },
        { "title": "What can you build?", "message": "What can you build for me?" }
      ]
    }
  },
  "oauth_config": {
    "redirect_urls": ["https://api.jungleagents.com/auth/slack-agent/callback"],
    "scopes": {
      "bot": [
        "im:history",
        "im:write",
        "chat:write",
        "chat:write.customize",
        "assistant:write",
        "users:read",
        "users:read.email"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://api.jungleagents.com/api/slack/agent-events",
      "bot_events": ["message.im", "app_home_opened"]
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

Keep the scope list in sync with `AGENT_SCOPES` in `backend/src/http/routes/slackAgentApp.ts`.

## Testing

```bash
node backend/test/slack-stub.mjs 3056 &
# backend on :3055 with SLACK_API_BASE=http://localhost:3056,
# SLACK_AGENT_SIGNING_SECRET=test_agent_signing_secret, SLACK_OUTBOX_TICK_MS=1000
node backend/test/slack-agent-e2e.mjs 3055 "$TEST_DB_URL" test_agent_signing_secret 3056
node backend/test/slack-e2e.mjs      3055 "$TEST_DB_URL" test_signing_secret_abc123   # mirror regression
```

The agent e2e seeds **both** installs in one workspace on purpose — the failures worth catching
(posting with the wrong app's token, a channel message delivered twice) only appear when both exist.

## Deliberately not built

- **Channel handling on this app.** Channels stay the mirror's job; the agent app ignores anything
  that isn't `channel_type: "im"`. That single rule is what prevents double delivery.
- **An interactive App Home.** It is a read-only roster with links into Jungle web. Slack is where
  you talk to agents; Jungle web is where you arrange them.
