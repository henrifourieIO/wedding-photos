# Wedding Photos

A Cloudflare-hosted wedding album: the host creates an event and shares a QR code; guests scan it to capture or upload photos and short videos into a shared, moderated gallery with optional live photo wall. This repository is a pnpm monorepo with a Hono Worker API and a React SPA served from the same Worker.

## Local development

Requirements: Node 22.12+ (see `.nvmrc`), pnpm 10.16+ (see `packageManager` in `package.json`).

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

### Worker Builds (dashboard deploy)

This repo is a pnpm workspace. **Do not** run `npx wrangler deploy` from the repository root—Wrangler will fail with an application-detection error because it is not scoped to `apps/worker`.

| Dashboard field | Value |
| --------------- | ----- |
| Build command | `pnpm run build` |
| Deploy command | `pnpm run deploy` |

Equivalent deploy command:

```bash
pnpm --filter @wedding-photos/worker exec wrangler deploy --env production
```

Staging: `pnpm run deploy:staging` (or the same filter command with `--env staging`).

The top-level `[vars]` block in `apps/worker/wrangler.toml` sets `DEV_BYPASS_ACCESS=true` for local dev. **Production deploys must pass `--env production`** (and staging must use `--env staging`); otherwise those dev vars would ship to Cloudflare.

Stream secrets are covered under [Video (Cloudflare Stream)](#video-cloudflare-stream).

### Guest upload secrets

Set with `pnpm exec wrangler secret put <NAME> --cwd apps/worker` (add `--env staging` / `--env production` as needed):

| Secret                 | Purpose                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `GUEST_COOKIE_SECRET`  | HMAC key for the signed guest cookie. Generate with `openssl rand -base64 32`. Required in staging/production; without it `POST /api/events/:code/guests` returns **503** JSON (`guest_cookie_secret_not_configured` + setup hint) instead of creating a guest. |
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

## Video (Cloudflare Stream)

Guests upload videos straight to Cloudflare Stream (direct creator uploads); Stream transcodes (including iPhone HEVC `.mov`) and calls back a signed webhook that flips the clip to `ready`.

1. Enable Stream: dashboard -> Stream -> subscribe (a paid add-on).
2. Create an API token with **Account -> Stream -> Edit** (the deploy token from the plan already includes it, or make a dedicated one).
3. Set Worker secrets/vars (add `--env staging` / `--env production` as needed):

   ```bash
   pnpm exec wrangler secret put STREAM_API_TOKEN --cwd apps/worker
   pnpm exec wrangler secret put STREAM_ACCOUNT_ID --cwd apps/worker   # optional; falls back to R2_ACCOUNT_ID
   ```

4. Register the webhook once per environment and store the printed signing secret:

   ```bash
   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
     ./scripts/stream-webhook.sh https://<app-origin>/api/webhooks/stream
   pnpm exec wrangler secret put STREAM_WEBHOOK_SECRET --cwd apps/worker
   ```

   Stream supports one webhook URL per account, so staging and production need separate Cloudflare accounts or you re-register when switching.

5. Apply migration `0004_media_video.sql` (see commands above).

Notes: clips over 200 MB use the tus (resumable) endpoint, otherwise a one-time upload URL; max clip length comes from `events.video_max_seconds` (default 60). Optional var `MAX_VIDEO_BYTES` caps upload size (default 5 GB). The web `VideoPlayer` component (`apps/web/src/components/VideoPlayer.tsx`) plays the stored HLS URL (native on Safari, `hls.js` elsewhere).

**Cost:** Stream bills per minute stored (about $5 per 1,000 minutes) and per minute delivered (about $1 per 1,000 minutes); encoding and ingress are free. Example: 200 guests x 5 clips x 20 s is roughly 330 stored minutes, about $1.70 per month, plus delivery. Check current pricing at cloudflare.com/products/stream.

## Photo processing

`POST /api/events/:code/uploads/:id/complete` enqueues `{ mediaId, eventId }` on `PHOTO_QUEUE`; the consumer in `apps/worker/src/queue.ts` (`lib/process.ts`) then:

1. Loads the `media` row (`uploaded` -> `processing`; already `ready`/`rejected`/`failed` rows are skipped, so redelivery is idempotent) and reads the original from R2.
2. Validates magic bytes (JPEG, PNG, WebP, HEIC) against the declared `content_type`. Mismatch, unknown or undecodable files get status `rejected` with a `reason`.
3. Reads EXIF orientation and `DateTimeOriginal` (`taken_at`) plus dimensions (`width`/`height` are display dimensions, orientation applied).
4. Writes `events/<event_id>/thumb/<id>.jpg` (max 400 px) and `events/<event_id>/web/<id>.jpg` (max 2000 px), re-encoded from decoded pixels so no EXIF/GPS survives. Sets `ready`, `processed_at`, `thumb_key`, `web_key`.

Decoder: [`@cf-wasm/photon`](https://github.com/fineshopdesign/cf-wasm) (WASM, ~1.5 MB, runs in Workers; no Images binding or extra Cloudflare product/token needed, and it works under the local test runtime). Limits: decoded pixels use Worker memory (128 MB), so images over 16 MP and all HEIC/HEIF are marked `ready` **without** thumb/web derivatives (`reason` = `no_derivative_oversize` / `no_derivative_heic`); the SPA downsizes to JPEG on the client in most cases. Non-owners cannot fetch the original (it may contain GPS), so such photos are visible only to their uploader.

Retries: transient errors call `message.retry()` with exponential backoff; on attempt 3 (`MAX_ATTEMPTS`) the row becomes `failed` with `error` and the message is acked. `max_retries = 3` and a dead-letter queue (`photo-uploaded-dlq`, `photo-uploaded-staging-dlq`) catch invocations that crash before reaching that code.

Routes:

- `GET /api/events/:code/media/:id/:variant` (`thumb|web|orig`): streams from R2. `thumb`/`web` need `ready`, not hidden and a revealed gallery; the uploader (guest cookie) can always fetch their own. `orig` is uploader-only.
- `POST /api/events/:code/uploads/:id/reprocess`: uploader re-enqueues a photo (e.g. after `failed`).

Migration `0003_media_processing.sql` adds `reason`, `error`, `processed_at`, `thumb_key`, `web_key`. Run `scripts/cf-setup.sh` (or `wrangler queues create`) for the new DLQ queues and apply migrations before deploying.

## Guest gallery and reveal

Guest SPA route: `/e/:joinCode/gallery` (masonry grid, lightbox, save/share via Web Share API or download). Polls `GET /api/events/:code/gallery` every few seconds; a future `EventRoom` WebSocket can replace polling when the live wall ships.

Visibility for guests: `status = ready`, not host-hidden, and reveal rules from the event — `instant` (immediate), `delayed` (after `reveal_at`), or `private` (host-only; guests see an empty “host-only album” state). The JSON includes `gallery_visible`, `reveal_mode`, and `reveal_at` for countdown UI when the album is still locked.

Photo tiles load `/api/events/:code/media/:id/thumb` or `web`; videos use stored HLS + poster in the lightbox (`VideoPlayer`). Empty states cover “not revealed yet” and “no photos yet”.

Pagination: `page_size` (default 50, max 100) and `cursor` (base64 JSON of `created_at` + `id`).

## Host moderation and ZIP

Host event page (`/host/events/:id`) lists **all** media via `GET /api/host/events/:id/media` (includes hidden, pending, failed). Actions:

- `PATCH /api/host/events/:id/media/:mediaId` with `{ "hidden": true|false }` — hide from the guest gallery without deleting storage.
- `DELETE /api/host/events/:id/media/:mediaId` — removes the D1 row and deletes R2 keys (`orig`, `thumb`, `web`) plus the Cloudflare Stream asset when `stream_uid` is set (requires `STREAM_API_TOKEN`).

Bulk download: `GET /api/host/events/:id/zip` streams a ZIP built in the Worker with [`client-zip`](https://github.com/Touffy/client-zip): photos from R2 (`web` preferred, else `orig`), videos by fetching the Stream MP4 download URL (`videodelivery.net/.../downloads/default.mp4`). Limits (documented caps, enforced server-side):

| Limit            | Value                                      |
| ---------------- | ------------------------------------------ |
| Max files in ZIP | 200 ready, non-hidden items                |
| Max ZIP size     | ~2 GB estimated (413 `zip_too_large`)      |

Videos need Stream configured; photos need R2 objects present. Failures for individual entries are skipped until nothing remains (`no_downloadable_media`).

## Host access (Cloudflare Access)

The host dashboard (`/host/*`) and host API (`/api/host/*`) are protected by **Cloudflare Access** (Zero Trust). The Worker verifies the `Cf-Access-Jwt-Assertion` header using your team domain and application AUD tag.

### Configure Access

1. Open [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Access** → **Applications** → **Add an application**.
2. Choose **Self-hosted**.
3. Application domain: your Worker hostname with path rules for `/host` and `/api/host` (e.g. `wedding-photos.<your-subdomain>.workers.dev/host` and the same host with `/api/host`). Add both path prefixes to one app or use a wildcard path policy on that hostname as needed.
4. **Policies**: Allow → Include → **Emails** → your host email only.
5. Save the application and copy the **AUD** tag from the application settings.

### Worker configuration (required for production)

`auth.ts` reads **`CF_ACCESS_TEAM_DOMAIN`** and **`CF_ACCESS_AUD`** from the Worker **environment** (`c.env`). In Cloudflare these may be **Variables** or **Secrets**; both are exposed to the Worker the same way. **Do not commit real values in git.**

The production deploy uses `[env.production]` in `apps/worker/wrangler.toml`. That block must define these bindings in the dashboard (or via `wrangler secret` / `wrangler var`); commented placeholders in `wrangler.toml` are documentation only.

| Variable                | Example                         | Purpose                                          |
| ----------------------- | ------------------------------- | ------------------------------------------------ |
| `CF_ACCESS_TEAM_DOMAIN` | `yourteam.cloudflareaccess.com` | Zero Trust team domain (Settings → Custom pages) |
| `CF_ACCESS_AUD`         | (AUD tag from the Access app)   | Audience claim for JWT verification              |

**Dashboard (fastest fix for `401` / `reason: access_not_configured`):**

1. [Cloudflare dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **wedding-photos** → **Settings** → **Variables and Secrets**.
2. Open the **Production** environment (matches `wrangler deploy --env production`).
3. Add **Variable** (plain text is fine):
   - Name: `CF_ACCESS_TEAM_DOMAIN` — value: your team domain from Zero Trust → **Settings** → **Custom pages** (format `something.cloudflareaccess.com`).
   - Name: `CF_ACCESS_AUD` — value: **Application Audience (AUD) Tag** from your Access app (Access → Applications → your app → Overview). You can store AUD as a **Secret** instead if you prefer; the Worker code does not distinguish.
4. **Save**. Worker environment variables usually apply without a new deploy; if host API still returns `access_not_configured`, trigger a deploy from **Deployments** or run `pnpm exec wrangler deploy --env production --cwd apps/worker`.

**CLI alternative** (same bindings, nothing in git):

```bash
cd apps/worker
pnpm exec wrangler var put CF_ACCESS_TEAM_DOMAIN --env production
pnpm exec wrangler secret put CF_ACCESS_AUD --env production
```

If the JSON error is `missing_token` instead, add `/api/host` to the Access application paths (see below), not only `/host`.

## Repository layout

- `apps/worker` — Hono on Cloudflare Workers, D1, R2, KV, Queues, Durable Object `EventRoom`
- `apps/web` — React + Vite SPA (static assets binding)
- `scripts/cf-setup.sh` — one-time Cloudflare resource creation
- `scripts/stream-webhook.sh` — registers the Stream webhook and prints its signing secret
