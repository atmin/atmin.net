# Media deduplication (client-side, opt-out)

v0.1 uploads each attachment as a fresh ULID-addressed blob with a fresh
random AES-256-GCM key, even when the same file has been sent before.
This is simple and has a pleasant side effect: the server sees distinct
ciphertexts at distinct paths on every send, so it cannot correlate
sends of the same file across recipients.

A post-v0.1 optimization: the client maintains an IndexedDB table of
its own sent attachments, keyed by plaintext SHA-256, and reuses the
existing `{url, key, iv}` tuple when the same file is sent again.

## Design

Per-device table:

```ts
{
  sha256: string,           // plaintext SHA-256, primary key
  url: string,              // media/{uid}/{ulid}
  key: Uint8Array,          // 32 bytes
  iv:  Uint8Array,          // 12 bytes
  mime: string,
  name: string,
  size: number,
  firstSentAt: number,
}
```

Send path:

1. Compute `sha256(plaintext)`.
2. Lookup.
3. Hit → reuse `{url, key, iv}` verbatim in a new envelope; skip upload.
4. Miss → encrypt fresh, upload, insert after both PUT and `/v1/send`
   succeed.

The row corresponds to a blob referenced by at least one sent envelope,
so it is always in the GC-referenced set (see
[media-gc.md](./media-gc.md)) — dedup and GC are mutually safe.

## Tradeoff: server-linkability

With dedup, the same URL and ciphertext appear across envelopes to
multiple recipients. The server learns "these sends correspond to the
same underlying file," which it could not infer from the v0.1 per-send
fresh-upload pattern.

Recipient-to-recipient linkability does **not** change: two colluding
recipients can already compare SHA-256 of the decrypted plaintext (which
is carried in the Megolm payload and can also be recomputed locally).
Dedup adds nothing to their capability.

Device-local attacker: neutral — the dedup table is no more sensitive
than the message history already on disk.

## Why this is a client decision

Dedup is invisible at the protocol level. Different clients, or the
same client with the setting toggled, can coexist without coordination
or version negotiation. The recipient sees an ordinary media envelope
either way.

## Recommended shipping plan

- **Default on.** Bandwidth and quota win are real; server-linkability
  cost is marginal for a self-hosted messenger.
- **Settings toggle**: "Reuse uploads of the same file across chats.
  Turning this off means each send uploads a fresh copy — the server
  can no longer tell when you send the same file to multiple people."
- **No per-conversation control** in the first iteration — global toggle
  is enough.
- **Multi-device**: each device has its own table. Cross-device sync of
  the manifest is possible (encrypted blob on S3, analogous to
  contacts) but adds correctness work; defer until use case emerges.

## Second benefit: orphan suppression

Dedup is not just a bandwidth/quota win — it's also the primary
structural mitigation for orphan blobs.

Without dedup, the user-level recovery pattern for a flaky send ("did
that photo actually send? Let me try again.") produces an orphan every
time the original PUT succeeded but `/v1/send` didn't: the resend
re-encrypts with a fresh key and ULID, uploads a second blob, and the
first blob is now unreferenced. Human hesitation on unreliable networks
is the largest orphan-production path.

With dedup, the resend computes the plaintext SHA-256, hits the table,
reuses the existing `{url, key, iv}`, and sends a fresh envelope
pointing at the same blob. No second upload, no orphan. Retries become
idempotent at the blob layer.

This matters for the shipping-order decision: dedup *before* GC reduces
the orphan rate at the source, while GC *before* dedup only sweeps up
after it. Neither is wrong, but dedup is the cheaper of the two and has
compounding benefit.

## Why deferred from v0.1

The 25 MB per-blob cap and 1 GiB per-user quota bound the cost of
redundant uploads. Dedup is a pure optimization with a metadata
tradeoff worth a deliberate discussion, which is easier to have once
the core media flow is in production.
