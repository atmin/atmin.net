# Media garbage collection

v0.1 does not reclaim orphan media blobs — if a client uploads the
ciphertext but never completes the corresponding `POST /v1/send`, the
blob sits in `media/{uid}/` counting against the user's quota until
account deletion. Server-side sweeps are not possible under E2E because
envelopes are opaque.

Under client cooperation GC *is* possible, with two specific correctness
hazards to address.

## Algorithm

Only the user uploads to `media/{uid}/`, and every device syncs the full
inbox (self-copy envelopes guarantee this). So on each device, after a
full sync:

```
referenced   = { env.payload.file.url
                 for every decrypted media envelope in my inbox }
server_blobs = list(media/{uid}/)
candidates   = server_blobs − referenced
```

For each `blob ∈ candidates` with `LastModified` older than **24 h**,
issue `DELETE /v1/store/object?key=<blob>`.

### Correctness hazards

1. **Sync lag across devices.** Device A uploads + sends. Device B runs
   GC before syncing the new envelope → B sees the blob, doesn't know a
   message references it, deletes it.
   *Mitigation*: run GC only after a full inbox sync catches up to the
   server's latest `msg_id` in the current session.
2. **Upload without send.** Device A PUTs, tab crashes before
   `POST /v1/send`. A legitimate orphan — but if A recovers and retries
   quickly, deleting forces a re-upload.
   *Mitigation*: 24 h grace period based on S3 `LastModified` before a
   candidate is eligible for deletion.

With both guards, GC is correct and non-destructive.

## Server changes

One new endpoint, scoped to the caller's own prefixes:

```
DELETE /v1/store/object?key=media/{uid}/{ulid}
```

- Auth: token's `user_id` must match `{uid}` in the key.
- Same `authorizeKey` guard as reads, flipped to write-scoped.
- Quota counter is invalidated on success (next presign refreshes via
  `ListObjectsV2`).

## Client policy

- Run at most once per session, or once per N hours, whichever is longer.
- Cap deletions per run (e.g. 50) to avoid a storm after a long absence.
- Run strictly after a full inbox sync in the current session.

## Why this is deferred from v0.1

Shipping GC requires (a) a new server endpoint, (b) an IndexedDB cursor
confirming "full sync reached," and (c) e2e coverage for both hazards.
None is technically hard, but the per-user quota bounds the blast radius
of orphans in v0.1, so the feature's urgency is low relative to core
messaging correctness.

## Open direction: deletable attachments via indirection

v0.1 envelopes are immutable by design — Megolm ciphertexts are written
once and never rewritten — so "delete this photo I sent" is not
expressible within a message. Attachments, however, can be modelled as
a separate, mutable layer *alongside* envelopes:

```
envelope.payload.file.attachment_id = "att_01HXYZ..."

attachments/{uid}/{attachment_id}   ← small JSON blob, mutable
  { "url": "media/{uid}/{ulid}",
    "key": "...", "iv": "...", "name": "...", "size": ... }
```

The envelope carries only the `attachment_id`. Recipients resolve it
via `GET attachments/{from_uid}/{attachment_id}`, then fetch the
ciphertext as today. The sender (or any of their devices) can delete
the attachment object; recipients see `unavailable` from that point on.
The underlying `media/` blob is deleted in the same operation.

**Client-side attachment table.** Each device maintains an IndexedDB
table of its own live attachments, keyed by `attachment_id`, with
`url`, key material, plaintext SHA-256, first-send timestamp, and a set
of `msg_id`s that reference it. The table is the authoritative
GC-referenced set from that device's perspective:

```
referenced   = { row.url for row in attachments_table }
server_blobs = list(media/{uid}/)
candidates   = server_blobs − referenced
```

This replaces the "scan decrypted envelopes" step in the current GC
algorithm with a direct table read, avoiding a full inbox walk on every
sweep. It also lets dedup (see [media-dedup.md](./media-dedup.md)) reuse
rows safely — the dedup table and the attachment table become the same
table, with the dedup key (plaintext SHA-256) as a secondary index.

The table is per-device. Cross-device sync of the attachment table
(encrypted blob on S3, like contacts) is a natural extension and makes
multi-device delete consistent without requiring each device to re-walk
the full inbox. Deferring sync until after the single-device version
ships keeps the correctness surface small.

Envelope-side compatibility: readers that don't understand
`attachment_id` fall back to `file.url` if both are present during
transition. Post-transition the `url`-in-envelope form is retired.

None of this is v0.1 scope; capturing it here so the deletability
question doesn't drift into ad-hoc protocol changes later.
