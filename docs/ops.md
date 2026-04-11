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
- **e2e** job: Playwright against Go server + Vite + MinIO service container
- **deploy** job: only runs on `v*` tags, after lint + test + e2e all pass

### GitHub Secrets required

| Secret | Description |
|--------|-------------|
| `SCW_SECRET_KEY` | Scaleway API secret key (used for registry login + deploy) |
| `SCW_REGISTRY_ENDPOINT` | e.g. `rg.fr-par.scw.cloud/atmin` |
| `SCW_CONTAINER_ID` | Serverless Container ID |

## Deployment

### One-time Scaleway setup

```bash
# 1. Container Registry
scw registry namespace create name=atmin region=fr-par

# 2. Object Storage bucket (via console or s3cmd)
#    Create bucket "atmin" in fr-par, generate API keys

# 3. Serverless Container namespace
scw container namespace create name=atmin region=fr-par

# 4. Push initial image (registry creates the repo on first push)
docker login rg.fr-par.scw.cloud/atmin -u nologin -p <SCW_SECRET_KEY>
docker tag atmin rg.fr-par.scw.cloud/atmin/atmindotnet:latest
docker push rg.fr-par.scw.cloud/atmin/atmindotnet:latest

# 5. Create the container (first deploy)
scw container container create \
  namespace-id=<NAMESPACE_ID> \
  name=atmin \
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
#    atmin.net → <container-endpoint>.scw.cloud
```

### Deploying

Tag a commit and push:

```bash
git tag v0.1.0
git push --tags
```

This triggers lint → test → e2e → deploy. The image is tagged with the version (e.g. `v0.1.0`) and `latest`.

Pushing to `master` without a tag runs the full CI pipeline (lint, test, e2e) but does not deploy.

### Local build & run

```bash
docker build -t atmin .
docker run --env-file .env -p 8080:8080 atmin
```

## Future considerations

- **Redis/NATS**: only needed for multi-instance SSE fanout, presence, and typing indicators. Single-instance uses in-memory EventHub. Scaleway Managed Redis available on Private Networks when needed.
- **Scaling**: S3 is source of truth, container is stateless — horizontal scaling is just more containers behind DNS. No shared mutable state to coordinate.
