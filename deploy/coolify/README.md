# ChatbotX on Coolify (single server, Traefik, linux/arm64)

Deployment recipe for running ChatbotX as a **Coolify service** (Docker Compose)
on a single ARM64 host. Images come from this fork:

```
ghcr.io/aarondev911/chatbotx-builder:main
ghcr.io/aarondev911/chatbotx-worker:main
ghcr.io/aarondev911/chatbotx-realtime:main
ghcr.io/aarondev911/chatbotx-javascript-executor:main
```

They are published as `linux/arm64` and are **public**, so the server needs no
registry credentials.

## Architecture

```
                    Traefik (Coolify proxy)
 https://app.DOMAIN ──────────────┬──► builder:3000
 https://app.DOMAIN/ws ───────────┘──► realtime:1999      (path stripped)
 https://assets.DOMAIN ───────────────► filesystem:9000   (rustfs, S3)

 builder ──► postgres:5432 (timescaledb pg18)
 builder ──► redis:6379
 builder ──► javascript-executor:3210 (isolated network)
 worker  ──► postgres, redis, filesystem, javascript-executor
 builder ──► filesystem via public S3 URL (presigned URLs are signed)
```

Three containers are reachable from the internet: `builder`, `realtime`
(path `/ws`) and `filesystem`. Nothing binds a host port; Coolify connects its
proxy container to the service network.

## 1. DNS and TLS

Create two names pointing at the server:

| Name | Purpose |
|---|---|
| `app.DOMAIN` | UI + API + realtime under `/ws` |
| `assets.DOMAIN` | object storage (uploads, public files) |

For the **first** deployment keep both records **DNS-only (grey cloud)** so
Traefik can complete the HTTP-01 challenge. Once the certificates are issued you
may enable the Cloudflare proxy.

If you enable the proxy:

- SSL/TLS mode must be **Full (strict)**.
- WebSockets are on by default (required for `/ws`).
- Cloudflare caps request bodies (100 MB on Free/Pro) — uploads to
  `assets.DOMAIN` larger than that are rejected at the edge.

## 2. Required environment variables

Set these in the Coolify service **Environment Variables** panel (not in the
compose file). `docker compose` interpolates them from the `.env` Coolify
writes next to the compose file.

| Variable | Value | Notes |
|---|---|---|
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` | ≥ 32 chars |
| `BETTER_AUTH_URL` | `https://app.DOMAIN` | exact public origin |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` | **URL-safe**: it is embedded in `DATABASE_URL` |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` | exactly 64 hex chars |
| `JAVASCRIPT_EXECUTOR_TOKEN` | `openssl rand -hex 32` | ≥ 32 chars |
| `REALTIME_BROADCAST_SECRET` | `openssl rand -hex 32` | ≥ 32 chars |
| `NEXT_PUBLIC_BUILDER_URL` | `https://app.DOMAIN` | |
| `NEXT_PUBLIC_STORAGE_URL` | `https://assets.DOMAIN/chatbotx` | browser-facing storage base |
| `NEXT_PUBLIC_INTERNAL_STORAGE_URL` | `https://assets.DOMAIN/chatbotx/` | injected into the client bundle at runtime |
| `S3_ENDPOINT` | `https://assets.DOMAIN` | must be the **public** origin: presigned URLs are signed path-style |
| `S3_BUCKET` | `chatbotx` | |
| `S3_REGION` | `us-west-2` | any value; rustfs ignores it |
| `S3_ACCESS_KEY_ID` | e.g. `chatbotx` | must equal `RUSTFS_ACCESS_KEY` |
| `S3_SECRET_ACCESS_KEY` | `openssl rand -hex 24` | must equal `RUSTFS_SECRET_KEY` |
| `RUSTFS_ACCESS_KEY` | same as `S3_ACCESS_KEY_ID` | |
| `RUSTFS_SECRET_KEY` | same as `S3_SECRET_ACCESS_KEY` | |
| `SMTP_FROM` | `ChatbotX <no-reply@DOMAIN>` | **required**: the mail schema refuses to start without it |

Optional:

| Variable | Default | Notes |
|---|---|---|
| `POSTGRES_DB` / `POSTGRES_USER` | `chatbotx` / `chatbotx` | |
| `NEXT_PUBLIC_EDITION` | `community` | |
| `COMMUNITY_MAX_WORKSPACES` | `1` | max workspaces per user in the community edition |
| `LOG_LEVEL` | `info` | |
| `SMTP_SERVER` | `smtp://username:password@localhost:1025` | leave unset if you have no SMTP: mail sending fails, the app still boots |
| `RUN_DB_MIGRATE` | `true` | keep enabled |
| `RUN_DB_SEED` | `false` | set `true` for the **first** boot only |
| `JAVASCRIPT_EXECUTOR_MAX_CONCURRENCY` | `2` | raise only with CPU headroom |

`DATABASE_URL` is composed from `POSTGRES_*`; do not set it manually.

## 3. Create the service in Coolify

1. **Project** → environment → **+ New** → **Docker Compose** (service).
2. Server: the host itself (`localhost`). Destination: `coolify`.
3. Paste `deploy/coolify/docker-compose.yml` as the compose file and save.
4. Add the environment variables from the table above.
5. Set **Domains** per compose service:

   | Service | Domain | Settings |
   |---|---|---|
   | `builder` | `https://app.DOMAIN` | strip prefix: n/a |
   | `realtime` | `https://app.DOMAIN/ws` | **strip prefix ON** |
   | `filesystem` | `https://assets.DOMAIN` | strip prefix OFF |

   Both `builder` and `realtime` share the `app.DOMAIN` host; Traefik routes
   `/ws` to realtime because the longer `PathPrefix` rule wins. Do not remove
   `/ws` from the realtime domain, and do not turn off strip-prefix: partykit
   expects `/parties/...`, not `/ws/parties/...`.

6. Set `RUN_DB_SEED=true` for the first deployment only.

## 4. Deploy

Press **Deploy** and watch the **deployment log** (not the service status card,
which lags behind the build/pull).

The first pull moves roughly 2 GB (`timescaledb-ha:pg18-all` ~1.5 GB plus the
three Node images). Depending on bandwidth this takes 5–20 minutes. **Do not
delete, stop or redeploy the service while it is pulling** — an interrupted
`docker compose pull` leaves nothing to resume from and restarts the download.

A successful first boot shows, in the builder logs:

```
Running database migrations...
Running database seed...      # only when RUN_DB_SEED=true
```

Then set `RUN_DB_SEED=false` and redeploy once. Migrations are idempotent and
stay enabled.

## 5. Verify

```bash
# builder
curl -sS https://app.DOMAIN/api/health
# -> {"status":"healthy","service":"builder",...}

# UI
curl -sS -o /dev/null -w '%{http_code}\n' https://app.DOMAIN/

# realtime: the upgrade must reach partykit (101 = handshake, 401/403 = routed + auth)
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://app.DOMAIN/ws/parties/workspaces/test

# storage: bucket created by filesystem-init, served over Traefik + TLS
curl -sS -o /dev/null -w '%{http_code}\n' https://assets.DOMAIN/chatbotx/public/empty
```

In Coolify every container should read `running (healthy)` except
`filesystem-init`, which is a one-shot job and exits by design (`exited 0`).

Then upload an image from the UI: this exercises presigned PUT against
`S3_ENDPOINT`, which is where a mismatched `S3_*` / `RUSTFS_*` pair shows up.

### Health probes

Traefik's Docker provider ignores containers Docker reports as `unhealthy`, so a
failing probe silently removes that container's routers and requests fall
through to the catch-all (`503 no available server`). Two probes are
non-obvious:

- **builder**: Next's standalone server binds `process.env.HOSTNAME`, which
  Docker sets to the container id, so it never listens on `127.0.0.1`. The
  compose pins `HOSTNAME=0.0.0.0` for the probe on `127.0.0.1:3000/api/health`.
- **realtime**: PartyKit only routes `/parties/<party>/<room>`, so a root
  `/health` is a 404 for every image. The probe targets
  `/parties/main/health`, which the main party answers with 200 and which is
  also public as `/ws/parties/main/health` — the quickest way to confirm that a
  new `:main` image actually rolled out.

`pull_policy: always` keeps `:main` honest: without it `docker compose up`
reuses the cached image and reports a successful deploy of stale code.

## 6. Operación

- **Update**: redeploy with a pinned tag instead of `:main`
  (`ghcr.io/aarondev911/chatbotx-builder:sha-<commit>`); every build publishes
  both.
- **Volumes**: `db-data`, `filesystem-data`, `redis-data` are owned by the
  service and survive redeploys. Back up `db-data` and `filesystem-data`
  together — object paths live in Postgres.
- **Logs**: builder/worker/realtime logs are the app logs; `filesystem-init`
  logs only its bucket bootstrap.
- `/assets/*` is no longer proxied by the builder at runtime (the rewrite was a
  build-time fallback). `NEXT_PUBLIC_STORAGE_URL` is the single source of
  storage URLs; add a Traefik rule if you ever need the legacy path.
