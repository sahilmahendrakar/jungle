# Jungle iOS

Native SwiftUI client for Jungle — same backend, new client (the Slack desktop ↔ Slack mobile
relationship with `frontend/`).

## Requirements

- Xcode 16.2+ (project uses filesystem-synchronized groups; adding a Swift file under
  `Jungle/` needs no pbxproj edit)
- iOS 17.0+ deployment target

## Running

Open `ios/Jungle.xcodeproj`, select your signing team on the Jungle target, pick a device or
simulator, Run.

**Against a local backend** (Debug builds only): run `npm run dev` at the repo root *without*
`FIREBASE_SERVICE_ACCOUNT` set (enables the backend's DEV_BYPASS auth), make sure the backend
is reachable on your LAN, then in the app's dev sign-in screen toggle "Use LAN backend", enter
your Mac's LAN IP, and sign in with a participant id from your local database. Debug builds
carry an ATS exception for plain-HTTP LAN traffic; Release builds are locked to
`https://api.jungleagents.com`.

## Wire contract mapping

`shared/src/*.ts` is the canonical wire contract. The Swift mirrors are hand-ported 1:1 — **a
PR that touches a file on the left must touch the file on the right**:

| shared/src | ios/Jungle/Wire |
|---|---|
| `domain.ts` | `Domain.swift` |
| `ws-events.ts` | `WSEvents.swift` |
| `constants.ts` | `Constants.swift` |
| `integrations.ts` | `Integrations.swift` (M3+) |
| `schedules.ts` | `Schedules.swift` (M4) |
| `slack.ts` | `WSEvents.swift` (SlackChannelLink) / `SlackTypes.swift` (M4) |
| `deliverables.ts` | `Domain.swift` (Deliverable) |

REST endpoints mirror `frontend/src/api.ts` (grouped into `Networking/APIClient+*.swift`);
WebSocket semantics mirror `frontend/src/ws/useChatSocket.ts`; the live-turn buffer mirrors
`frontend/src/ws/useLiveTurns.ts` (250 ms throttle, 300-event cap — keep the invariants).

## Push notifications

Push rides FCM through the existing Firebase project (`jungle-agents`): the app registers its
FCM token via `POST /api/push/register`; the backend pushes on DM messages, @mentions, and
tool-confirmation requests (with Allow/Deny actions on the notification) from `fanOut` in
`backend/src/ws/appSocket.ts`, suppressed while the recipient has a live socket.

One-time setup still needed before pushes actually deliver:
1. Apple Developer portal → Keys → create an **APNs auth key** (.p8).
2. Firebase console → Project settings → Cloud Messaging → **upload the .p8** under Apple app
   configuration for `com.jungleagents.ios`.
3. Run on a physical device (simulators don't receive APNs), signed with a team that has the
   Push Notifications capability.

## Test scaffolding (Debug builds)

Simulator automation can't tap, so Debug builds honor env vars set at launch via
`SIMCTL_CHILD_`-prefixed vars: `JUNGLE_AUTO_OPEN=<channelId>` opens a channel,
`JUNGLE_AUTO_SEND=<text>` posts once into it, `JUNGLE_AUTO_ACTIVITY=<agentId>` opens the
Activity sheet. Dev sessions can be seeded with
`xcrun simctl spawn <sim> defaults write com.jungleagents.ios devSessionParticipantId <id>`.

## Verifying a build from the CLI

```sh
xcodebuild -project ios/Jungle.xcodeproj -scheme Jungle \
  -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO
```
