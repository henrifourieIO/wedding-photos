# Wedding Photos

A Cloudflare-hosted wedding album: the host creates an event and shares a QR code; guests scan it to capture or upload photos and short videos into a shared, moderated gallery with optional live photo wall. This repository is a pnpm monorepo with a Hono Worker API and a React SPA served from the same Worker.

## Local development

Requirements: Node 20+ (see `.nvmrc`), pnpm 10.16+ (see `packageManager` in `package.json`).

```bash
pnpm install
pnpm dev
```

`pnpm dev` builds the web app and runs `wrangler dev` in `apps/worker`, serving the SPA and API together. API health check: `GET /api/health`. Host dashboard: `/host` (local dev uses `DEV_BYPASS_ACCESS=true` in `apps/worker/wrangler.toml`).

Other commands:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Cloudflare setup

Wrangler is a devDependency at the repo root and in `apps/worker`. After `pnpm install`, run it from the repo root with `pnpm exec wrangler` and point at the Worker config with `--cwd apps/worker` (this avoids re-running pnpm’s install policy checks that `pnpm exec` can trigger on some machines).

Log in first:

```bash
pnpm exec wrangler login --cwd apps/worker
```

Then run the setup script (it invokes `apps/worker/node_modules/.bin/wrangler` directly and does not call `pnpm exec`):

```bash
chmod +x scripts/cf-setup.sh
./scripts/cf-setup.sh
```

It creates D1 databases, R2 buckets, KV namespaces, and Queues for staging and production, then prints IDs to paste into `apps/worker/wrangler.toml` (replace `REPLACE_WITH_*` placeholders). Apply migrations:

```bash
pnpm exec wrangler d1 migrations apply wedding-photos --remote --cwd apps/worker
pnpm exec wrangler d1 migrations apply wedding-photos-staging --remote --env staging --cwd apps/worker
```

## Secrets and deploy

**GitHub Actions** (Settings → Secrets and variables → Actions):

| Secret                  | Purpose                                          |
| ----------------------- | ------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`  | Deploy token (Workers, D1, R2, KV, Queues, etc.) |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID                       |

Pushes to `main` run `.github/workflows/deploy.yml` and deploy the production Worker. PRs run typecheck, lint, and tests via `.github/workflows/ci.yml`.

**Worker secrets** (add when implementing Stream): `STREAM_API_TOKEN`, `STREAM_WEBHOOK_SECRET` via `pnpm exec wrangler secret put <NAME> --cwd apps/worker`.

### Guest upload secrets

Set with `pnpm exec wrangler secret put <NAME> --cwd apps/worker` (add `--env staging` / `--env production` as needed):

| Secret                 | Purpose                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `GUEST_COOKIE_SECRET`  | HMAC key for the signed guest cookie. Generate with `openssl rand -base64 32`.      |
| `R2_ACCOUNT_ID`        | Cloudflare account ID, used for the R2 S3 endpoint `<id>.r2.cloudflarestorage.com`. |
| `R2_ACCESS_KEY_ID`     | R2 S3 API access key ID.                                                            |
| `R2_SECRET_ACCESS_KEY` | R2 S3 API secret access key.                                                        |

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

The host dashboard (`/host/*`) and host API (`/api/host/*`) are protected by **Cloudflare Access** (Zero Trust). The Worker verifies the `Cf-Access-Jwt-Assertion` header using your team domain and application AUD tag.

### Configure Access

1. Open [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Access** → **Applications** → **Add an application**.
2. Choose **Self-hosted**.
3. Application domain: your Worker hostname with path rules for `/host` and `/api/host` (e.g. `wedding-photos.<your-subdomain>.workers.dev/host` and the same host with `/api/host`). Add both path prefixes to one app or use a wildcard path policy on that hostname as needed.
4. **Policies**: Allow → Include → **Emails** → your host email only.
5. Save the application and copy the **AUD** tag from the application settings.

### Worker configuration

Set these on the production (and staging) Worker—via `wrangler.toml` `[vars]` or `wrangler secret` as you prefer:

| Variable | Example | Purpose |
|----------|---------|---------|
| `CF_ACCESS_TEAM_DOMAIN` | `yourteam.cloudflareaccess.com` | Zero Trust team domain (Settings → Custom pages) |
| `CF_ACCESS_AUD` | (AUD tag from the Access app) | Audience claim for JWT verification |

Do **not** set `DEV_BYPASS_ACCESS` in production. Local `wrangler dev` uses `DEV_BYPASS_ACCESS=true` in the default `[vars]` block so you can use `/host` without Access.

Guest routes stay public and use per-event join codes only.

## Repository layout

- `apps/worker` — Hono on Cloudflare Workers, D1, R2, KV, Queues, Durable Object `EventRoom`
- `apps/web` — React + Vite SPA (static assets binding)
- `scripts/cf-setup.sh` — one-time Cloudflare resource creation
