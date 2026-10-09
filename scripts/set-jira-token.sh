#!/usr/bin/env bash
# Simpan API token Jira/Atlassian ke macOS Keychain. Token diketik di prompt `security`,
# tidak pernah muncul di argumen, history shell, atau file.
set -euo pipefail
SERVICE="tech-lead-cockpit.jira"
ACCOUNT="${1:-default}"
echo "Menyimpan API token Jira/Atlassian ke Keychain (service: $SERVICE, account: $ACCOUNT)"
security add-generic-password -U -s "$SERVICE" -a "$ACCOUNT" -w
echo "Tersimpan di Keychain. Token ini juga dapat digunakan untuk Confluence."
