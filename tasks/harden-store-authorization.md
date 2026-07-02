# Harden store authorization (compact + cross-user reads)

> Owner-scope the destructive `compact` path and the cross-user read
> allow-list. **Audit findings:** C1 (critical), M1, L3 · **Priority: P0 — do
> first.**

## Why it matters

`authorize_prefix` ([paths.rs:69](../server/src/paths.rs)) scopes
`inbox/keys/media` to the caller but its final clause
`prefix.starts_with("users/")` returns `true` for **any** caller and **any**
victim — it exists only for public profile/key *reads*.

- **C1 (critical).** `store_compact` ([routes.rs](../server/src/routes.rs), the
  `authorize_prefix` gate) authorizes a **destructive delete** with that
  read-permissive check. An attacker resolves a victim's ULID (public via
  `GET /v1/resolve/{handle}`) and `POST /v1/store/compact` with
  `{"prefix":"users/{VICTIM}/profile.json","up_to":"~"}` — the handler lists →
  writes an archive → **deletes every listed live object**. Deleting
  `profile.json` (or `devices/`) locks the victim out of every future request.
  Remote, targeted account destruction. The owner-only helper
  `authorize_key_write` ([paths.rs:90](../server/src/paths.rs)) already exists —
  it's just not used here.
- **M1.** Same root cause on the read path: `store_object`/`store_list` let any
  authenticated user `GET users/{VICTIM}/contacts.json` /
  `read-markers.json` (AES-GCM ciphertext + the already-public `salt`/`kdf` →
  material for an *offline* backup-key guess) and enumerate devices/rotation
  history. Contradicts the threat model ([vision.md](../docs/vision.md): "what
  stays secret is … contacts, devices, keys").
- **L3 (fold-in).** `POST /v1/devices` verifies only signature + a ±300 s
  window with no server nonce ([authproof.rs](../server/src/authproof.rs)) — a
  captured proof is replayable for 5 minutes. Narrow (device_id is signed), but
  cheap to close alongside.

## Current

`authorize_prefix` allows any `users/…` for any caller; `store_compact` and
`store_list` gate on it, `store_object` on `authorize_key`. The
`compact_other_users_prefix_is_403` test only covers an `inbox/{other}/`
prefix — never the exploitable `users/{other}/` one.

## Change

1. Compact is a destructive write — authorize it owner-only. Tightest: require
   `req.prefix` to equal the caller's own `inbox/{uid}/live/` or
   `keys/{uid}/live/`. (Add `authorize_prefix_write` mirroring
   `authorize_key_write` if a broader shape is needed.)
2. Replace the blanket `starts_with("users/")` read allowance with an explicit
   public allow-list: cross-user reads only for `users/{uid}/profile.json`
   (+ `devices/{did}.json` if multi-device key distribution needs it).
   Everything else under `users/{uid}/` becomes owner-only; reject cross-user
   `users/{uid}/` listing (or restrict to `devices/`).
3. L3: bind auth-proofs to a short-lived server-issued nonce burned on use
   (mirror the PoW flow) or a seen-signature TTL cache; make the freshness
   window one-sided (reject future timestamps).

## Verify

- Handler tests: `compact users/{other}/profile.json` and `.../devices/` →
  `403` **and** victim objects still present. `GET users/{other}/contacts.json`
  → `403`. `list users/{other}/` → `403` (or `devices/`-only).
- The `paths.rs` unit tests that assert "any `users/…` path is readable"
  ([paths.rs:130-131,145](../server/src/paths.rs)) get updated to the
  allow-list.
