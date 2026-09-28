#!/bin/bash
echo "==> Updating package lists..."
sudo apt-get update -y || true
echo "==> Installing Claude Code CLI..."
sudo npm install -g @anthropic-ai/claude-code
echo "==> Claude Code installation finished successfully!"
