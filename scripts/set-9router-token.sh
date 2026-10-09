#!/usr/bin/env bash
# Simpan API key / token 9Router ke macOS Keychain. Token diketik di prompt `security`,
# tidak pernah muncul di argumen, history shell, atau file.
set -euo pipefail
SERVICE="tech-lead-cockpit.9router"
ACCOUNT="${1:-default}"
echo "Menyimpan API Key 9Router ke Keychain (service: $SERVICE, account: $ACCOUNT)"
security add-generic-password -U -s "$SERVICE" -a "$ACCOUNT" -w
echo "Tersimpan. Restart 'npm run dev' bila sedang berjalan."
