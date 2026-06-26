# Operations

Living document — infrastructure, deployment, and CI decisions.

## Infrastructure

| Component | Provider | Product |
|-----------|----------|---------|
| Compute | Scaleway | Serverless Containers (min-scale: 1, custom domain via CNAME) |
| Storage | Scaleway | Object Storage (S3-compatible) |
| Registry | Scaleway | Container Registry |

### Why Scaleway Serverless Containers

- No load balancer needed — custom domains via CNAME with auto TLS
- min-scale: 1 keeps one instance warm (no cold starts)
- Stateless Rust container: signs presigned URLs, validates auth, routes to S3
- Can scale to 0 in dev, always-on in prod

### Operational stance: EU-resident infrastructure

The running service runs on EU-resident infrastructure for
data-sovereignty reasons. GitHub and the surrounding CI tooling
are acknowledged exceptions; nothing on the request/data path
crosses an EU boundary.

This is a constraint, not a religion — multiple EU-resident
S3-compatible providers exist (OVH, Hetzner, Exoscale, Wasabi EU,
IDrive E2 EU, etc.). Scaleway is the v0.1 choice; if the choice
ever changes, the constraints below need re-verification.

### Object storage constraints

Scaleway Object Storage is S3 API-compatible but **does not
support request preconditions** — neither `If-Match` nor
`If-None-Match` on `PutObject`. The feature has been requested
since 2023 ([open feature request, off-roadmap as of 2024-05](https://feature-request.scaleway.com/posts/1133/support-conditional-writes-in-object-storage)).
The recent Object Lock addition is the WORM/retention feature, not
request preconditions; do not confuse them.

This shapes two parts of the system design:

- **Backup-secret rotation** ([ADR-0012](decisions/adr-0012-backup-secret-rotation.md))
  uses an in-process per-`user_id` mutex to serialize the
  GET-VERIFY-WRITE on `profile.json`, instead of an `If-Match`
  ETag-conditional write.
- **User-chosen handle claim** ([ADR-0013](decisions/adr-0013-user-chosen-handles.md))
  uses an in-process per-handle mutex to serialize the
  GET-then-PUT on `handles/{handle}.json`, instead of an
  `If-None-Match: *` conditional create.

Both depend on the server running as a single process today.
Multi-instance deployment requires a future ADR that picks a
shared-state substrate (Redis SETNX, Postgres advisory locks,
etc.) and migrates these primitives along with the other
in-process state (SSE hub, device-existence cache,
profile-`key_version` cache, media-quota cache).

If the backend later changes to one that supports preconditions
(or if Scaleway eventually ships the feature), both ADRs can be
revisited to drop the mutex pattern in favour of conditional
writes — but the single-instance assumption still holds, so the
mutexes don't *need* to come out unless multi-instance is the
goal of the change.

### Resource tiers (for reference)

| Memory | vCPU |
|--------|------|
| 128 MB | 70m |
| 256 MB | 140m |
| 512 MB | 280m |
| 1024 MB | 560m |
| 2048 MB | 1120m |
| 3072 MB | 1680m |
| 4096 MB | 2240m |

## Cost envelope (MVP)

| Component | Tier | Monthly |
|-----------|------|---------|
| Container | 128 MB / 70m vCPU, always-on | ~€0.70 (within free tier) |
| Object Storage | pay-per-use | ~€0 at low volume |
| Container Registry | free tier | €0 |

Free tier: 200k vCPU-s + 400k GB-s per month per account.

## CI

GitHub Actions (`.github/workflows/deploy.yml`):

- **Trigger**: push to `master` or `v*` tag
- **lint** job: `cargo fmt --check` + `clippy -D warnings`, `biome check`, architecture lint — blocks on any violation
- **test** job: Rust unit tests, web unit tests
- **build** job: Docker image build — runs on every push to `master`
- **e2e** job: Playwright against the server image + MinIO service container — `v*` tags only
- **deploy-staging** job: deploys to `staging.atmin.net` on every green master push (after lint + test + build)
- **deploy-prod** job: deploys to `app.atmin.net` on `v*` tags only, after lint + test + e2e all pass

### GitHub Secrets required

| Secret | Description |
|--------|-------------|
| `SCW_ACCESS_KEY` | Scaleway access key (starts with `SCW`) |
| `SCW_SECRET_KEY` | Scaleway API secret key (used for registry login + deploy) |
| `SCW_ORGANIZATION_ID` | Scaleway organization ID |
| `SCW_PROJECT_ID` | Scaleway project ID |
| `SCW_REGISTRY_ENDPOINT` | e.g. `rg.fr-par.scw.cloud/atmin` |
| `SCW_CONTAINER_ID` | Serverless Container ID (production) |
| `SCW_STAGING_CONTAINER_ID` | Serverless Container ID (staging) |
| `SCW_CLEANUP_JOB_DEFINITION_ID` | Serverless **Job** definition ID for the data-retention cleanup (see "Scheduled cleanup") |

### Server runtime env vars

Set on the Scaleway Serverless Container (separately for
staging and production):

| Variable | Description |
|----------|-------------|
| `ROCKET_ADDRESS` / `ROCKET_PORT` | bind address/port — baked to `0.0.0.0:8080` in the image (Dockerfile); override only if the platform routes to a different port |
| `ROCKET_LOG_LEVEL` | optional log verbosity: `off` \| `critical` (warn+) \| `normal` (default — request access log + warnings) \| `debug` (also Rocket routing + dependency logs, for tracing a request) |
| `LOG_BODIES` | **dev/debug only — never production.** When `1`/`true`, logs request and response **bodies** of `/v1/` calls (`msg=request_body` / `msg=response_body`, capped, SSE skipped). Off by default. Handy with `make dev`: `LOG_BODIES=1 make dev`. |
| `SERVER_SECRET` | HMAC secret for token signing |
| `S3_ENDPOINT` | S3-compatible endpoint URL |
| `S3_PUBLIC_ENDPOINT` | optional override for presigned-URL host |
| `S3_BUCKET` | bucket name |
| `S3_REGION` | region (default `auto`) |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | bucket credentials |
| `CLEANUP_INACTIVE_DAYS` | cleanup job only — inactive-user deletion threshold (default `180`) |
| `CLEANUP_BATCH_SIZE` | cleanup job only — max users deleted per run (default `100`) |
| `DANGEROUSLY_DISABLE_REGISTRATION_POW` | **test/e2e only — never production.** Disables the registration proof-of-work ([ADR-0020](decisions/adr-0020-registration-proof-of-work.md)) only when set to the exact magic value `yes-i-am-the-e2e-suite`; any other value or unset leaves it on (fail-closed). Boot logs a loud warning when off. |

## Deployment

### One-time Scaleway setup

```bash
# 1. Container Registry
scw registry namespace create name=atmin region=fr-par

# 2. Object Storage bucket (via console)
#    Create bucket "atmindotnet" in fr-par, generate API keys.
#    Then apply CORS (see "Bucket CORS" below) so browsers can PUT
#    to presigned URLs from app.atmin.net.

# 3. Serverless Container namespace
scw container namespace create name=atmin region=fr-par

# 4. Push initial image (registry creates the repo on first push)
#    Scaleway requires amd64 — build with --platform on ARM Macs
docker login rg.fr-par.scw.cloud/atmin -u nologin -p <SCW_SECRET_KEY>
docker build --platform=linux/amd64 -t rg.fr-par.scw.cloud/atmin/atmindotnet:latest .
docker push rg.fr-par.scw.cloud/atmin/atmindotnet:latest

# 5. Create the container (first deploy)
scw container container create \
  namespace-id=<NAMESPACE_ID> \
  name=atmindotnet \
  registry-image=rg.fr-par.scw.cloud/atmin/atmindotnet:latest \
  min-scale=1 max-scale=1 \
  memory-limit=128 \
  port=8080 \
  environment-variables.S3_REGION=fr-par \
  secret-environment-variables.0.key=SERVER_SECRET \
  secret-environment-variables.0.value=<run `openssl rand -base64 32` for a good one> \
  secret-environment-variables.1.key=S3_ENDPOINT \
  secret-environment-variables.1.value=https://s3.fr-par.scw.cloud \
  secret-environment-variables.2.key=S3_BUCKET \
  secret-environment-variables.2.value=atmindotnet \
  secret-environment-variables.3.key=S3_ACCESS_KEY \
  secret-environment-variables.3.value=<KEY> \
  secret-environment-variables.4.key=S3_SECRET_KEY \
  secret-environment-variables.4.value=<SECRET>

# 6. Custom domain — add CNAME record:
#    app.atmin.net → <container-endpoint>.scw.cloud
```

### Staging one-time setup

```bash
# 1. Object Storage bucket (via console)
#    Create bucket "atmindotnetstaging" in fr-par.
#    Apply CORS for https://staging.atmin.net (same procedure as production below).

# 2. Create the staging container (min-scale=0 — idles to zero when unused)
scw container container create \
  namespace-id=<NAMESPACE_ID> \
  name=atmindotnet-staging \
  registry-image=rg.fr-par.scw.cloud/atmin/atmindotnet:master \
  min-scale=0 max-scale=1 \
  memory-limit=128 \
  port=8080 \
  environment-variables.S3_REGION=fr-par \
  secret-environment-variables.0.key=SERVER_SECRET \
  secret-environment-variables.0.value=<run `openssl rand -base64 32` — must differ from production> \
  secret-environment-variables.1.key=S3_ENDPOINT \
  secret-environment-variables.1.value=https://s3.fr-par.scw.cloud \
  secret-environment-variables.2.key=S3_BUCKET \
  secret-environment-variables.2.value=atmindotnetstaging \
  secret-environment-variables.3.key=S3_ACCESS_KEY \
  secret-environment-variables.3.value=<KEY> \
  secret-environment-variables.4.key=S3_SECRET_KEY \
  secret-environment-variables.4.value=<SECRET>

# 3. Custom domain — add CNAME record:
#    staging.atmin.net → <staging-container-endpoint>.scw.cloud

# 4. Add SCW_STAGING_CONTAINER_ID to GitHub secrets.
```

Same Docker image as production — only env vars differ (`S3_BUCKET`, `SERVER_SECRET`).
The server serves the SPA (embedded at build time); all fetch calls are same-origin
relative, so no build-time URL changes are needed.

### Scheduled cleanup

Data-retention cleanup (ADR-0006) runs the **same image** as a one-shot
**Scaleway Serverless Job** on a daily cron — not in-process (the server is
stateless and only one runner should sweep). It deletes abandoned and inactive
users, and sweeps expired handle tombstones once past the 30-day cooldown
(ADR-0013). The `cleanup` subcommand reuses the server's S3 client; output is
logs (`user_id`/`handle_key`, `policy`, `dry_run`), which flow to the same log
pipeline (ADR-0010).

```sh
./atmin cleanup            # dry-run, logs matches only
./atmin cleanup --apply    # actually deletes
```

One-time setup (production region/bucket):

```bash
# 1. Create the job definition. Small tier — the sweep is I/O-bound (S3
#    list/delete), nothing like the app's request path. command overrides the
#    image ENTRYPOINT (/atmin) args.
#
#    NOTE: the cleanup reads only the S3 env (S3_ENDPOINT, S3_BUCKET,
#    S3_ACCESS_KEY, S3_SECRET_KEY; S3_REGION optional). It does NOT need
#    SERVER_SECRET — the cleanup path never launches the HTTP server.
scw jobs definition create \
  name=atmin-cleanup \
  image-uri=rg.fr-par.scw.cloud/atmin/atmindotnet:latest \
  cpu-limit=140 memory-limit=256 \
  job-timeout=10m \
  command="cleanup --apply" \
  environment-variables.S3_REGION=fr-par \
  environment-variables.CLEANUP_INACTIVE_DAYS=180 \
  environment-variables.CLEANUP_BATCH_SIZE=100 \
  secret-environment-variables.0.key=S3_ENDPOINT \
  secret-environment-variables.0.value=https://s3.fr-par.scw.cloud \
  secret-environment-variables.1.key=S3_BUCKET \
  secret-environment-variables.1.value=atmindotnet \
  secret-environment-variables.2.key=S3_ACCESS_KEY \
  secret-environment-variables.2.value=<KEY> \
  secret-environment-variables.3.key=S3_SECRET_KEY \
  secret-environment-variables.3.value=<SECRET>

# 2. Store the returned job-definition-id as the GitHub secret
#    SCW_CLEANUP_JOB_DEFINITION_ID (so CI can repoint it at new images).

# 3. Attach a daily cron schedule (03:00 Europe/Brussels).
scw jobs cron create \
  job-definition-id=<JOB_DEFINITION_ID> \
  schedule="0 3 * * *" \
  timezone="Europe/Brussels"
```

**Rollout (ADR-0006 safeguard):** create the definition with `command="cleanup"`
(dry-run) first, let the cron run for ~a week, review the `cleanup match` logs,
then update to `command="cleanup --apply"` once the matches look right:

```bash
scw jobs definition update <JOB_DEFINITION_ID> command="cleanup --apply"
```

Manually trigger a run any time (e.g. to verify after setup):

```bash
scw jobs run create job-definition-id=<JOB_DEFINITION_ID>
```

### Bucket CORS

Browser uploads use presigned PUT URLs. The bucket must allow the app origin, or the browser blocks the request at preflight. Scaleway's console doesn't expose CORS — it's API-only. Use `s3cmd`.

Install and configure once:

```bash
brew install s3cmd
s3cmd --configure
```

Answers for the Scaleway prompts:

| Prompt | Value |
|--------|-------|
| Access Key / Secret Key | Scaleway API key pair |
| Default Region | `fr-par` |
| S3 Endpoint | `s3.fr-par.scw.cloud` |
| DNS-style bucket+hostname template | `%(bucket)s.s3.fr-par.scw.cloud` |
| Encryption password / GPG path | blank / default |
| Use HTTPS protocol | Yes |
| HTTP Proxy | blank |

Save `cors.xml`:

```xml
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>https://app.atmin.net</AllowedOrigin>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <MaxAgeSeconds>3000</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
```

Apply and verify:

```bash
s3cmd setcors cors.xml s3://atmindotnet
s3cmd info s3://atmindotnet
```

Takes effect immediately.

### Deploying

**Staging** — automatic on every push to `master`:

```bash
git push origin master
```

Triggers lint → test → build → deploy to `staging.atmin.net`. No tagging needed.
Staging always reflects the current state of `master`. Use it for mobile device testing
and manual verification before cutting a release.

**Production** — tag a commit and push:

```bash
git tag v0.1.0
git push --tags
```

Triggers lint → test → e2e → deploy to `app.atmin.net`. The image is tagged with the
version (e.g. `v0.1.0`) and `latest`. e2e is a hard gate; staging has no e2e requirement.

### Local build & run

```bash
docker build -t atmin .
docker run --env-file .env -p 8080:8080 atmin
```

## Marketing site (`atmin.net`)

A static brochure ([ADR-0025](decisions/adr-0025-marketing-site.md)),
**separate from the app container**. The build (`site/dist`, Astro) is published
to **GitHub Pages**, which serves the **bare apex** `atmin.net` over HTTPS with
an auto-provisioned (Let's Encrypt) certificate. Source in
[`site/`](../../site/); deploy is path-filtered CI
(`.github/workflows/site.yml`), independent of the app's `deploy.yml`.

**Why GitHub Pages, not Scaleway.** The hard constraint is the apex. Scaleway's
custom-domain products (Edge Services, Containers) are CNAME-based, and a CNAME
can't exist at an apex, so none can serve the bare `atmin.net` (the only Scaleway
path is a Load Balancer at ~10× the app's monthly cost). GitHub Pages serves an
apex via `A`/`AAAA` records with free managed TLS. It's US-hosted
(Microsoft/Fastly), accepted because the brochure carries **no user data and has
no request/data path** — the EU-resident stance is about the product's *data
path*, where GitHub/CI is already an acknowledged exception. **Pragmatic is
better than pure** (see ADR-0025).

### One-time setup

1. **Enable Pages** (repo → Settings → Pages): Source = *Deploy from a branch*,
   branch = `gh-pages` / `(root)`. The first `site.yml` run creates `gh-pages`
   (peaceiris), so let it run once, then set this.

2. **Custom domain**: set `atmin.net` in Settings → Pages → Custom domain — the
   deploy already writes the `CNAME` file (the workflow's `cname:`), so this
   confirms it and triggers cert provisioning. Tick **Enforce HTTPS** once the
   cert is ready (up to 24h).

3. **DNS** (zone on Scaleway DNS, `ns*.dom.scw.cloud`):
   - Apex `atmin.net` → four **A** records: `185.199.108.153`,
     `185.199.109.153`, `185.199.110.153`, `185.199.111.153`.
   - Apex `atmin.net` → four **AAAA** records: `2606:50c0:8000::153`,
     `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`.
   - `www.atmin.net` → **CNAME** `atmin.github.io.` — the Pages host, **not** the
     apex (GitHub warns an apex-pointing `www` breaks Enforce-HTTPS).
   - `app.` and `staging.` are unchanged (they front the Rust container).

### Decommissioning the old Scaleway path

The site previously synced to a Scaleway bucket behind Edge Services. After the
GitHub Pages cutover, remove the orphaned (paid) resources:

- Delete the **Edge Services pipeline** for the site (console → Edge Services).
- Delete the **`atmin-site` bucket** (console → Object Storage).
- Remove any **`www` CNAME → `<id>.svc.edge.scw.cloud`** record left from the
  Edge attempt (replace with the `atmin.github.io` CNAME above).
- Drop the now-unused **`SCW_SITE_EDGE_PIPELINE_ID`** GitHub secret if it was set.

### GitHub Secrets

**None.** The deploy publishes to this repo's own `gh-pages` branch using the
default `GITHUB_TOKEN` — no PAT (unlike `storybook.atmin.net`, which publishes to
an external repo and needs `STORYBOOK_DEPLOY_TOKEN`).

### Deploying

Automatic on every push to `master` that touches `site/**`:

```bash
git push origin master
```

Builds (`astro check` + build) and publishes `dist/` to `gh-pages` (peaceiris,
which writes `.nojekyll` so Astro's `_astro/` assets survive Jekyll's
leading-underscore stripping). App-only changes don't trigger it; site-only
changes don't rebuild the app.

## Troubleshooting

```bash
# List containers and their status
scw container container list

# Get container details (including error messages)
scw container container get <CONTAINER_ID>

# View container logs — not available via CLI; use Cockpit (see Logging section below)

# Redeploy after pushing a new image
scw container container redeploy <CONTAINER_ID>

# Update container config — triggers automatic redeploy
# Pass ALL secrets together to be safe; unclear if omitted ones are wiped or preserved:
scw container container update <CONTAINER_ID> \
  environment-variables.S3_REGION=fr-par \
  secret-environment-variables.0.key=SERVER_SECRET  secret-environment-variables.0.value=<VALUE> \
  secret-environment-variables.1.key=S3_ENDPOINT    secret-environment-variables.1.value=<VALUE> \
  secret-environment-variables.2.key=S3_BUCKET      secret-environment-variables.2.value=<VALUE> \
  secret-environment-variables.3.key=S3_ACCESS_KEY  secret-environment-variables.3.value=<VALUE> \
  secret-environment-variables.4.key=S3_SECRET_KEY  secret-environment-variables.4.value=<VALUE>

# Add --wait to block until the redeploy completes
scw container container update <CONTAINER_ID> memory-limit=256 --wait

# List images in the registry
scw registry image list

# List registry namespaces
scw registry namespace list

# List serverless container namespaces
scw container namespace list

# Delete a container
scw container container delete <CONTAINER_ID>
```

## Logging (Cockpit)

Scaleway forwards container stdout/stderr to Cockpit automatically — no app changes needed.
Retention: 7 days (see ADR-0010).

Format is logfmt (`key=value`, never JSON — ADR-0010). Each request emits one access
line: `msg=request request_id=… method=… path=… status=… dur_ms=… ip=… user_id=…`.
The `request_id` (a ULID, or a vetted inbound `X-Request-Id`) is echoed in the
`X-Request-Id` response header, so a user/client error report carries the handle to
grep the exact request. `ip` is the first `X-Forwarded-For` value. At `normal` only
the app's own lines are emitted; set `ROCKET_LOG_LEVEL=debug` to also see Rocket's
per-request routing when tracing an issue.

### One-time setup

```bash
# Sync datasources to Grafana (required once before logs are queryable)
scw cockpit grafana sync-data-sources
```

### Querying logs

Scaleway console → Observability → Cockpit → Open Grafana → Explore → select Loki datasource

## Future considerations

- **Redis/NATS**: only needed for multi-instance SSE fanout, presence, and typing indicators. Single-instance uses in-memory EventHub. Scaleway Managed Redis available on Private Networks when needed.
- **Scaling**: S3 is source of truth, container is stateless — horizontal scaling is just more containers behind DNS. No shared mutable state to coordinate.
