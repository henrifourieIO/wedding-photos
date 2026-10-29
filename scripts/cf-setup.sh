#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="${ROOT}/apps/worker"
WRANGLER_BIN="${WORKER_DIR}/node_modules/.bin/wrangler"

if [[ ! -x "${WRANGLER_BIN}" ]]; then
  echo "error: wrangler not found at ${WRANGLER_BIN}" >&2
  echo "Run \`pnpm install\` from the repo root, then retry." >&2
  exit 1
fi

WRANGLER=("${WRANGLER_BIN}" --cwd "${WORKER_DIR}")

echo "Creating Cloudflare resources for wedding-photos (run from repo root)."
echo "Requires: \`pnpm exec wrangler login\` from the repo root (after pnpm install) or CLOUDFLARE_API_TOKEN set."
echo ""

create_d1() {
  local name="$1"
  echo "=== D1: ${name} ==="
  "${WRANGLER[@]}" d1 create "${name}" 2>&1 | tee /tmp/wd1-"${name}".txt || true
  grep -E "database_id|Created" /tmp/wd1-"${name}".txt || true
  echo ""
}

create_r2() {
  local name="$1"
  echo "=== R2: ${name} ==="
  "${WRANGLER[@]}" r2 bucket create "${name}" 2>&1 || echo "(bucket may already exist)"
  echo ""
}

create_kv() {
  local title="$1"
  echo "=== KV: ${title} ==="
  "${WRANGLER[@]}" kv namespace create "${title}" 2>&1 | tee /tmp/wkv-"${title}".txt || true
  grep -E "id|Created" /tmp/wkv-"${title}".txt || true
  echo ""
}

create_queue() {
  local name="$1"
  echo "=== Queue: ${name} ==="
  "${WRANGLER[@]}" queues create "${name}" 2>&1 || echo "(queue may already exist)"
  echo ""
}

echo "--- Production resources ---"
create_d1 "wedding-photos"
create_r2 "wedding-photos"
create_kv "wedding-photos-links"
create_queue "photo-uploaded"

echo "--- Staging resources ---"
create_d1 "wedding-photos-staging"
create_r2 "wedding-photos-staging"
create_kv "wedding-photos-links-staging"
create_queue "photo-uploaded-staging"

echo "--- Next steps ---"
cat <<'EOF'
1. Copy the database_id and KV namespace id values printed above into apps/worker/wrangler.toml
   (replace REPLACE_WITH_* placeholders for default, env.staging, and env.production as needed).

2. Apply D1 migrations locally or remotely (from repo root):
   pnpm exec wrangler d1 migrations apply wedding-photos --remote --cwd apps/worker
   pnpm exec wrangler d1 migrations apply wedding-photos-staging --remote --env staging --cwd apps/worker

3. Set GitHub Actions secrets on the repo:
   CLOUDFLARE_API_TOKEN
   CLOUDFLARE_ACCOUNT_ID

4. Optional Worker secrets (later PRs):
   pnpm exec wrangler secret put STREAM_API_TOKEN --cwd apps/worker
   pnpm exec wrangler secret put STREAM_WEBHOOK_SECRET --cwd apps/worker

5. Cloudflare Access: protect /host/* and /api/host/* with a Zero Trust application
   (allow-list your email). Guests use join codes only; no Access on guest routes.
EOF
