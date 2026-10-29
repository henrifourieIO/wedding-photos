# Wedding Photos

A Cloudflare-hosted wedding album: the host creates an event and shares a QR code; guests scan it to capture or upload photos and short videos into a shared, moderated gallery with optional live photo wall. This repository is a pnpm monorepo with a Hono Worker API and a React SPA served from the same Worker.

## Local development

Requirements: Node 20+ (see `.nvmrc`), pnpm 9+, Wrangler CLI.

```bash
pnpm install
pnpm dev
```

`pnpm dev` builds the web app and runs `wrangler dev` in `apps/worker`, serving the SPA and API together. API health check: `GET /api/health`.

Other commands:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Cloudflare setup

Run the setup script after logging in with Wrangler (`wrangler login`):

```bash
chmod +x scripts/cf-setup.sh
./scripts/cf-setup.sh
```

It creates D1 databases, R2 buckets, KV namespaces, and Queues for staging and production, then prints IDs to paste into `apps/worker/wrangler.toml` (replace `REPLACE_WITH_*` placeholders). Apply migrations:

```bash
cd apps/worker
wrangler d1 migrations apply wedding-photos --remote
wrangler d1 migrations apply wedding-photos-staging --remote --env staging
```

## Secrets and deploy

**GitHub Actions** (Settings → Secrets and variables → Actions):

| Secret | Purpose |
|--------|---------|
| `CLOUDFLARE_API_TOKEN` | Deploy token (Workers, D1, R2, KV, Queues, etc.) |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |

Pushes to `main` run `.github/workflows/deploy.yml` and deploy the production Worker. PRs run typecheck, lint, and tests via `.github/workflows/ci.yml`.

**Worker secrets** (add when implementing Stream): `STREAM_API_TOKEN`, `STREAM_WEBHOOK_SECRET` via `wrangler secret put`.

### Guest upload secrets

Set with `wrangler secret put <NAME>` (add `--env staging` / `--env production` as needed):

| Secret | Purpose |
|--------|---------|
| `GUEST_COOKIE_SECRET` | HMAC key for the signed guest cookie. Generate with `openssl rand -base64 32`. |
| `R2_ACCOUNT_ID` | Cloudflare account ID, used for the R2 S3 endpoint `<id>.r2.cloudflarestorage.com`. |
| `R2_ACCESS_KEY_ID` | R2 S3 API access key ID. |
| `R2_SECRET_ACCESS_KEY` | R2 S3 API secret access key. |

`R2_BUCKET_NAME` is a plain var in `wrangler.toml`. Optional var `MAX_UPLOAD_BYTES` overrides the 25 MB photo cap.

Create the R2 S3 API keys: Cloudflare dashboard -> R2 -> Manage R2 API Tokens -> Create API token -> permission **Object Read & Write**, scoped to the photos bucket. Copy the Access Key ID and Secret Access Key (shown once).

Browsers PUT directly to R2, so add a CORS rule to the bucket (R2 -> bucket -> Settings -> CORS Policy):

```json
[
  {
    "AllowedOrigins": ["https://<your-app-origin>"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

If the R2 S3 secrets are absent (local dev), uploads fall back to `PUT /api/events/:code/uploads/:id/body`, which streams through the Worker into the `PHOTOS` binding. For local dev create `apps/worker/.dev.vars` with `GUEST_COOKIE_SECRET=dev-secret`.

Apply the new migration (`0002_media_upload_fields.sql`) with the `wrangler d1 migrations apply` commands above.

## Host access (Cloudflare Access)

The host dashboard (`/host/*`) and host API (`/api/host/*`) will sit behind **Cloudflare Access** (Zero Trust) with an email allow-list—no custom login in app code. Configure an Access application in the dashboard for those paths before using the host features in later PRs. Guest routes stay public and use per-event join codes.

## Repository layout

- `apps/worker` — Hono on Cloudflare Workers, D1, R2, KV, Queues, Durable Object `EventRoom`
- `apps/web` — React + Vite SPA (static assets binding)
- `scripts/cf-setup.sh` — one-time Cloudflare resource creation
