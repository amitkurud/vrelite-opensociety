# Self-hosted deployment (your own PostgreSQL)

Runs the whole stack on one Docker host: PostgreSQL 17, a one-shot migration job, the API, the web dashboard, nightly database dumps, and an optional Caddy for HTTPS. Neon is not needed. Any `DATABASE_URL` whose host is not `*.neon.tech` uses the standard PostgreSQL driver (node-postgres with a connection pool).

Still external: **Clerk** (sign-in) and **Cloudflare R2** or another HTTPS S3-compatible store (uploads). Both have free tiers.

## Requirements

- Docker Engine with the Compose plugin, about 2 GB RAM free for building (around 1 GB at runtime)
- Two hostnames with HTTPS, e.g. `society.example.com` (web) and `api.society.example.com` (API). The mobile app and production config refuse plain HTTP.

## First start

```sh
git clone https://github.com/amitkurud/vrelite-opensociety.git
cd vrelite-opensociety/deploy/selfhost
cp .env.example .env
cp api.env.example api.env
chmod 600 .env api.env
# edit both files: POSTGRES_PASSWORD (openssl rand -hex 24), domains, Clerk keys, R2 credentials
docker compose up -d --build
docker compose ps        # migrate should be "Exited (0)", the rest Up/healthy
```

The startup order is enforced: `postgres` becomes healthy, then `migrate` applies `packages/db/drizzle`, then `api` starts. If a migration fails, the API does not start; check `docker compose logs migrate`.

## HTTPS

Pick one:

- **Bundled Caddy** (public IP, ports 80/443 open, DNS A records for both domains pointing here): `docker compose --profile caddy up -d --build`. Certificates are issued automatically.
- **Existing reverse proxy** on this host: keep `BIND_ADDRESS=127.0.0.1` and proxy `WEB_DOMAIN` → `127.0.0.1:3000` and `API_DOMAIN` → `127.0.0.1:8787`.
- **Reverse proxy or tunnel on another machine**: set `BIND_ADDRESS` to this server's LAN IP and firewall those ports to the proxy only.

## Clerk

In the Clerk dashboard: set the application URLs to `https://WEB_DOMAIN` and add a webhook to `https://API_DOMAIN/webhooks/clerk` for `user.created`, `user.updated` and `user.deleted`. Put its signing secret in `CLERK_WEBHOOK_SECRET`.

### First administrator

New sign-ups arrive as pending residents. Sign in once on the web dashboard, then promote yourself:

```sh
docker compose exec postgres psql -U opensociety -c \
  "UPDATE users SET role='ADMIN', status='APPROVED' WHERE email='you@example.com';"
```

## Updates

```sh
git pull
docker compose up -d --build   # rebuilds, re-runs migrate, restarts api/web
```

Back up first (see below). Migrations only move forward. To roll back the app, check out the previous commit and rebuild, but do not undo migrations.

To skip building on the server, set `API_IMAGE` and `MIGRATE_IMAGE` in `.env` to the GHCR images published by the **Build API image and Android app** workflow, then run `docker compose pull && docker compose up -d`. The web image is always built here because it bakes in your domain and Clerk key.

## Backups

The `backup` service writes `backups/opensociety-YYYYMMDD-HHMM.dump` on start and then every 24 hours, keeping `BACKUP_KEEP_DAYS` days. These dumps sit on the same disk, so copy them elsewhere (another machine, R2, a Proxmox backup). Restore into an empty database:

```sh
docker compose stop api
docker compose exec -T postgres pg_restore -U opensociety -d opensociety --clean --if-exists < backups/opensociety-YYYYMMDD-HHMM.dump
docker compose start api
```

Test a restore once before going live.

## Operations

- Status and logs: `docker compose ps`, `docker compose logs --tail=100 api web`, `docker stats --no-stream`
- Database shell: `docker compose exec postgres psql -U opensociety`
- Avoid `docker compose config` output in shared terminals; it prints secrets.
- Turn on `BILLING_ENABLED` after reviewing the bill configuration, and `PUSH_ENABLED` after FCM/APNs setup. Run only one API instance, since it also runs the background jobs.
