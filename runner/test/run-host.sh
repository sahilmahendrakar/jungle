#!/bin/bash
# Launch the runner on the host against the mock backend. Loads ANTHROPIC_API_KEY
# from the repo root .env WITHOUT printing it. Args: none (uses env below).
set -euo pipefail
cd "$(dirname "$0")/.."

KEY="$(grep -E '^ANTHROPIC_API_KEY=' /home/ec2-user/dev/jungle/.env | head -1 | cut -d= -f2- | tr -d '"'\''')"
if [ -z "$KEY" ]; then echo "ANTHROPIC_API_KEY empty" >&2; exit 1; fi
export ANTHROPIC_API_KEY="$KEY"

export JUNGLE_BACKEND_WS="${JUNGLE_BACKEND_WS:-ws://127.0.0.1:8790/api/runner}"
export JUNGLE_RUNNER_TOKEN="${JUNGLE_RUNNER_TOKEN:-test-secret}"
export JUNGLE_AGENT_ID="${JUNGLE_AGENT_ID:-agent-test-1}"
export JUNGLE_WORKSPACE="${JUNGLE_WORKSPACE:-/tmp/jungle-ws}"
export JUNGLE_STATE_DIR="${JUNGLE_STATE_DIR:-/tmp/jungle-ws/.jungle}"
export HOME="${HOME_OVERRIDE:-/tmp/jungle-ws/home}"
mkdir -p "$JUNGLE_WORKSPACE" "$JUNGLE_STATE_DIR" "$HOME"

exec node dist/index.js
