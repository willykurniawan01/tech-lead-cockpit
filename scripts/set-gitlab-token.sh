#!/usr/bin/env bash
# Simpan Personal Access Token GitLab internal (scope read_api) ke macOS Keychain. Token diketik di
# prompt `security`, tidak pernah muncul di argumen, history shell, atau file.
set -euo pipefail
SERVICE="tech-lead-cockpit.gitlab"
ACCOUNT="${1:-default}"
echo "Menyimpan Personal Access Token GitLab ke Keychain (service: $SERVICE, account: $ACCOUNT)"
echo "Buat token di GitLab: User Settings → Access Tokens, scope: read_api."
security add-generic-password -U -s "$SERVICE" -a "$ACCOUNT" -w
echo "Tersimpan di Keychain."
