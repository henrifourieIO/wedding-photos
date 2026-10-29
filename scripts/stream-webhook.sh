#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (needs Stream Edit)}"
URL="${1:?usage: $0 https://<app-origin>/api/webhooks/stream}"

RESPONSE="$(curl -sS -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/stream/webhook" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"notificationUrl\":\"${URL}\"}")"

SECRET="$(printf '%s' "${RESPONSE}" | sed -n 's/.*"secret":"\([^"]*\)".*/\1/p')"
if [ -z "${SECRET}" ]; then
  echo "Registration failed:" >&2
  echo "${RESPONSE}" >&2
  exit 1
fi

echo "Webhook registered for ${URL}"
echo "Signing secret: ${SECRET}"
echo "Store it with: pnpm exec wrangler secret put STREAM_WEBHOOK_SECRET --cwd apps/worker   (add --env staging|production)"
