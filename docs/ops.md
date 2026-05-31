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
- Stateless Go container: signs presigned URLs, validates auth, routes to S3
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

Both depend on the server running as a single Go process today.
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
- **lint** job: `go vet`, `biome check`, architecture lint — blocks on any violation
- **test** job: Go unit tests, web unit tests
- **build** job: Docker image build — runs on every push to `master`
- **e2e** job: Playwright against Go server + Vite + MinIO service container — `v*` tags only
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
| `LISTEN_ADDR` | optional, defaults to `:8080` |
| `SERVER_SECRET` | HMAC secret for token signing |
| `S3_ENDPOINT` | S3-compatible endpoint URL |
| `S3_PUBLIC_ENDPOINT` | optional override for presigned-URL host |
| `S3_BUCKET` | bucket name |
| `S3_REGION` | region (default `auto`) |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | bucket credentials |
| `VAPID_PUBLIC_KEY` | Web Push public key (base64url-encoded). See [ADR-0015](decisions/adr-0015-web-push.md). |
| `VAPID_PRIVATE_KEY` | Web Push private key (base64url-encoded) |
| `VAPID_SUBJECT` | RFC 8292 contact, e.g. `mailto:admin@atmin.net` |
| `CLEANUP_INACTIVE_DAYS` | cleanup job only — inactive-user deletion threshold (default `180`) |
| `CLEANUP_BATCH_SIZE` | cleanup job only — max users deleted per run (default `100`) |

Generate the VAPID keypair once per environment with
`webpush-go`'s `vapid.GenerateVAPIDKeys()` helper or any
RFC 8292-compatible tool. Staging and production should have
distinct pairs so a leaked staging key doesn't enable spoofed
production push.

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
The Go server serves the SPA; all fetch calls are same-origin relative, so no build-time
URL changes are needed.

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
#    NOTE: loadConfig() requires SERVER_SECRET, S3_ENDPOINT, S3_BUCKET,
#    S3_ACCESS_KEY, S3_SECRET_KEY even though cleanup only touches S3 — set the
#    same values as the container (SERVER_SECRET can be any non-empty value).
scw jobs definition create \
  name=atmin-cleanup \
  image-uri=rg.fr-par.scw.cloud/atmin/atmindotnet:latest \
  cpu-limit=140 memory-limit=256 \
  job-timeout=10m \
  command="cleanup --apply" \
  environment-variables.S3_REGION=fr-par \
  environment-variables.CLEANUP_INACTIVE_DAYS=180 \
  environment-variables.CLEANUP_BATCH_SIZE=100 \
  secret-environment-variables.0.key=SERVER_SECRET \
  secret-environment-variables.0.value=<any non-empty value> \
  secret-environment-variables.1.key=S3_ENDPOINT \
  secret-environment-variables.1.value=https://s3.fr-par.scw.cloud \
  secret-environment-variables.2.key=S3_BUCKET \
  secret-environment-variables.2.value=atmindotnet \
  secret-environment-variables.3.key=S3_ACCESS_KEY \
  secret-environment-variables.3.value=<KEY> \
  secret-environment-variables.4.key=S3_SECRET_KEY \
  secret-environment-variables.4.value=<SECRET>

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
