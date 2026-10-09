#!/usr/bin/env bash
# Simpan token Confluence ke macOS Keychain. Token diketik di prompt `security`,
# tidak pernah muncul di argumen, history shell, atau file.
set -euo pipefail
SERVICE="tech-lead-cockpit.confluence"
ACCOUNT="${1:-default}"
echo "Menyimpan token Confluence ke Keychain (service: $SERVICE, account: $ACCOUNT)"
security add-generic-password -U -s "$SERVICE" -a "$ACCOUNT" -w
echo "Tersimpan. Restart 'npm run dev' bila sedang berjalan."
