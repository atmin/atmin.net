# I10 — Key backups survive any session_id, and never fail silently

> Part of the [invariants index](./README.md). Priority **P1**.
> Spec: `web/e2e/invariants/key-backup-object-name.spec.ts`.

**Statement.** Every Megolm `session_id` the crypto layer can produce — including
ones containing S3-unsafe characters (`/`, `+`) at any position — backs up to a
**valid S3 object name** and round-trips through restore. And a key backup that
*does* fail is never silent: a failed backup is future history loss, so it is
logged legibly and queued for retry, not swallowed.

The general lesson, beyond this one key: **never interpolate an opaque or
externally-derived value into an S3 key segment without object-name-safe
encoding.** A `session_id` is base64 (alphabet includes `/` and `+`); raw, it can
form a leading / trailing / doubled `/`, which S3 and MinIO reject with
`XMinioInvalidObjectName` (400). The fix encodes the segment base64url
(`keys/{uid}/live/{base64url(session_id)}`); the envelope **body** keeps the raw
`session_id`, so restore — which lists the prefix and reads the body, never
reverse-parsing the key — is unaffected.

**Fault construction.**

- *Object-name safety (unit, authoritative):* `path.keyBackup(uid, sid)` for
  adversarial `sid` — leading `/`, trailing `/`, embedded `//`, and `+`/`=` —
  must yield a valid object name (one non-empty `base64url` segment under
  `live/`). Pairs with an envelope round-trip showing the body preserves the raw
  `sid`. Fully deterministic; this is the precise regression guard.
- *End-to-end (e2e):* a real conversation creates a real (random) inbound
  session, whose `session_id` is ~94% likely to contain a `/`/`+`. The test
  intercepts `POST /v1/store/presign` and asserts every presigned
  `keys/{uid}/live/` key is object-name-safe, then drives a fresh-device restore.
  The property holds for *all* `session_id`s, so the test passes deterministically
  on correct code; it catches a regression with high probability per session
  (and certainty across the suite, alongside the unit test and
  `flaky-compare.sh SPEC=credential-rotate-ui`, which hit ~4% pre-fix).

**Assertions.**

- *Unit:* every adversarial `sid` → `keyBackup` key matches
  `^keys/[^/]+/live/[A-Za-z0-9_-]+$` (no `//`, no leading/trailing `/`);
  `parse(wrap(…, sid)).sessionId === sid`.
- *Remote:* after the exchange, `keys/{uid}/` holds ≥1 backup object (i.e. the
  presigned PUT was accepted, not 400-rejected and dropped).
- *UI / Local:* on a fresh device with the correct secret, the message restores
  and renders — base64url-keyed blobs are readable end-to-end.

**Permitted divergence.** None for the object-name property — a backup either
lands at a valid key or the bug is present. The retry queue permits a transient
window: a backup that fails on a hard error is queued in IndexedDB and re-attempted
on the next sync, so Remote may briefly lack a blob the Local session already has —
but the failure is recorded, never silently dropped.
