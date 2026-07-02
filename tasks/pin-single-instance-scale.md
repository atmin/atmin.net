# Pin (and enforce) single-instance scale

> `max-scale=1` is a **correctness invariant**, but nothing in the repo pins or
> documents it. **Priority: High** (silent correctness risk). Surfaced while
> reconciling the resilience audit — the audit *assumed* `max-scale=1` without
> verifying.

## Why it matters

Every concurrency primitive is correct **only at exactly one running instance**:
the handle-claim and rotation per-key mutexes ([keyed_mutex.rs](../server/src/keyed_mutex.rs)),
the device-existence / profile-`key_version` / media-quota caches
([cache.rs](../server/src/cache.rs), [media_quota.rs](../server/src/media_quota.rs)),
and the SSE hub ([events.rs](../server/src/events.rs)) are all in-process
(ADR-0004's "in-process now, shared-state later"). If more than one instance
runs, the multi-instance race class the audit **dismissed** goes live:
split-brain handle claim, split key rotation, cross-replica stale
device-revocation (stolen-device window), N× media quota, cross-instance lost
SSE notify.

**The pin is not enforced.** `docs/ops.md` documents `min-scale: 1` (warm, no
cold start) but says **nothing about `max-scale`**. `deploy.yml` just runs
`scw container container redeploy <id>` ([deploy.yml:253](../.github/workflows/deploy.yml))
— it never sets scale. Scaleway Serverless Containers **autoscale by default**,
so unless `max-scale` is pinned to 1 on the container in the console, the
platform can spin up a second instance under load and the primitives are
silently unsafe. `min-scale: 1 ≠ max-scale: 1`.

## Current

`min-scale: 1` documented; `max-scale` unspecified in-repo (a console-only
setting on the container). No CI enforcement.

## Change

1. **Verify** the current `max-scale` on the prod + staging containers in the
   Scaleway console (lead with the console per the repo's infra-ops stance). It
   **must be 1** until the shared-state migration lands.
2. **Enforce durably** so it can't silently drift: add
   `scw container container update <id> min-scale=1 max-scale=1` to the deploy
   workflow (or, if CLI enforcement isn't wanted, document the required console
   value as a release checklist item).
3. The durable rationale is captured in `docs/ops.md` (single-instance is a
   correctness invariant) — see the note added alongside this task.

## Verify

- Console shows `max-scale=1` on prod + staging.
- Deploy asserts it (or the checklist requires confirming it).
- `docs/ops.md` records the requirement and the race list it gates.
