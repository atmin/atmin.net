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

TBD

## Deployment

TBD

## Future considerations

- **Redis**: only needed for realtime (presence, typing indicators, push routing). Not MVP. Scaleway Managed Redis available on Private Networks when needed.
- **Scaling**: S3 is source of truth, container is stateless — horizontal scaling is just more containers behind DNS. No shared mutable state to coordinate.
