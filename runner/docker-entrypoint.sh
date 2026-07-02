#!/bin/sh
# Runs as root: make sure the persistent /workspace volume is writable by `agent`,
# then drop privileges and exec the runner. The agent's home + session transcripts
# (CLAUDE_CONFIG_DIR) live under /workspace so memory survives container recreation.
set -e

mkdir -p /workspace/.jungle /workspace/home
chown -R agent:agent /workspace 2>/dev/null || true

# Keep Claude config + git credentials inside the persistent volume.
export HOME=/workspace/home
export CLAUDE_CONFIG_DIR=/workspace/.jungle/claude
export JUNGLE_STATE_DIR=/workspace/.jungle
mkdir -p "$CLAUDE_CONFIG_DIR"
chown -R agent:agent /workspace/home "$CLAUDE_CONFIG_DIR" 2>/dev/null || true

exec gosu agent "$@"
