# I13 — Media quota is enforced, legible, and freed by delete

> Part of the [invariants index](./README.md). Priority **P1**.
> Spec: `web/e2e/invariants/media-quota.spec.ts`.

**Statement.** No sequence of uploads pushes a user past the media quota
(1 GiB / 1000 blobs — `server/src/media_quota.rs`), and hitting the boundary
is never silent and never partial:

- a denied upload surfaces a visible error, renders no bubble, stores no
  Local row, sends no envelope, and lands no S3 object;
- the denial gates media only — text sends still flow;
- deleting a media message frees its quota promptly: the delete handler
  invalidates the per-user usage cache, so the next reservation re-probes S3
  instead of waiting out the 10-minute TTL.

The boundary check is `reserve_upload` at presign time: a cache-miss probe
lists the real `media/{uid}/` prefix, then optimistic increments track
reservations. `DeniedBytes` and `DeniedCount` both surface as the same
`413 quota_exceeded`.

**Enforcement is anchored server-side; the e2e adds the UX layer.** A
`routes.rs` handler test drives presign past the byte quota (in ≤ 25 MiB
chunks, since the per-object cap trips first) and asserts `413 quota_exceeded`
with zero bytes stored; a `media_quota.rs` unit test covers the blob-cap
`DeniedCount`. Those pin the enforcement deterministically and cheaply. The
e2e then covers only what the server test can't observe — the client surfacing
the denial as an alert, and quota freed by a delete — by seeding the blob cap
(the count cap seeds in milliseconds; a byte-quota seed would be a ~1 GiB
write).

**Shared-bucket caution.** Seeding ~1000 objects to reach the cap pollutes the
suite's shared `media/` prefix. That is safe only because every consumer
scopes its `media/` listing by `uid` — an unscoped `Prefix: 'media/'` list
returns one truncated 1000-key page and this seed will push another account's
blob off it. Keep media listings uid-scoped.

**Fault construction.**

1. Seed `media/{uid}/` to 999 objects directly in S3, *before* the account's
   first media action, so the server's first quota probe sees the seeded
   reality. (The only other probe path, `GET /v1/store/usage`, is called from
   the settings storage indicator — which the test never visits.)
2. Upload once — blob #1000, exactly at the cap — granted.
3. Upload again — #1001 — denied at presign; the send surfaces the failure
   via the alert path instead of an echoed bubble.
4. Delete the media message (the amendment path drops the blob and
   invalidates the cache), then upload again — granted.

**Assertions.**

- *Granted at the cap:* the recipient receives it; `media/{uid}/` holds
  exactly 1000 objects.
- *Denied:* the alert fires; the sender still shows exactly one attachment;
  the recipient gains nothing; the Remote count is unchanged; a text message
  still delivers both ways.
- *Freed:* after the delete, `media/{uid}/` drops to 999; the next upload
  lands, delivers, and returns the count to 1000.

**Permitted divergence.** The usage cache may *over*-count until its TTL
after an unused presign (optimistic increments are never reverted) — quota
may deny early, never admit past the cap. The reverse — a bounded ~2×
*under*-count overrun — is possible because the presigned-PUT TTL (15 min)
outlives the quota cache TTL (10 min): a batch of URLs reserved, then a
refresh re-probing S3 at ~0 during the overlap, admits a second batch. That
path needs clock control the e2e suite lacks; it is a noted gap here, tested
(if at all) at the unit layer. Multi-instance cache drift is out of scope for
v0.1: reservations serialize on a per-user in-process lock (the ADR-0004
"in-process now, shared state later" pattern).
