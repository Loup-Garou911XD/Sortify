#!/usr/bin/env bash
set -euo pipefail

echo "==> Fixing ownership of the persisted Claude config volume..."
# The named volume is created as root; hand it to the container user so that
# logins and settings written by Claude Code survive codespace rebuilds.
sudo chown -R "$(id -u):$(id -g)" "$HOME/.claude" || true

echo "==> Installing tmux (keeps sessions alive when the browser disconnects)..."
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tmux

echo "==> Installing Claude Code CLI..."
npm install -g @anthropic-ai/claude-code

echo "==> Installed: $(claude --version)"
echo "==> Done. Run 'claude' to log in, or 'tmux new -s claude' first for a detachable session."
