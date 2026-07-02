# Account-lifecycle serialization (delete / rotate / update)

> One per-uid lock + resumable delete + orphan sweep. **Audit findings:** H2,
> H3, M6, L2 · **Priority: High.**

## Why it matters

Three account-state writers use **different or no** locks and write
last-write-wins with no compare-and-swap (Scaleway has no `If-Match` —
[ops.md](../docs/ops.md)): `delete_profile` takes the *handle* mutex
([routes.rs:801](../server/src/routes.rs)), `rotate_keys` the *uid* mutex,
`update_profile` **none** (mutexes at [routes.rs:59,68,85](../server/src/routes.rs)).

- **H2 — deletion silently undone.** A co-device's `rotate_keys` reads
  `profile.json`, then the owner's `DELETE /v1/profile` wipes it and writes the
  tombstone; if delete lands between rotate's read and its unconditional
  `write_json`, rotate **resurrects** `profile.json` and its handle projection
  overwrites the tombstone. `add_device` is public, so the resurrected profile
  mints a working token — the account the owner deleted is alive again,
  controlled by the very device deletion was meant to cut off. `update_profile`
  (no lock) does the same. Violates i7's "resolve returns 410 throughout."
- **H3 — delete not atomic/resumable → permanent handle lockout.** The wipe
  deletes `profile.json` + `devices/` in its **first** iteration and writes the
  tombstone **last** ([routes.rs:808-855](../server/src/routes.rs)). Any failure
  after the first iteration → the retry dies at the `AuthedUser` guard
  (`DeviceRevoked`/`Unauthorized`) before reaching the tombstone write → the
  handle is locked forever (cleanup leaves dangling handles alone) and
  inbox/keys/media are orphaned. The `delete_profile_handle_contention_is_503`
  test's "a retry installs the tombstone" comment is provably wrong.
- **M6 — post-deletion sends → uncollectable orphans.** `send` accepts any
  `to_user` with no existence check ([routes.rs:979](../server/src/routes.rs));
  a contact who cached the deleted uid keeps sending → `inbox/{deleted}/live/…`;
  the empty-`user_id` tombstone means cleanup can never rediscover it. i7's
  "orphaned *and cleaned up*" is false — nothing collects it. (Flooding a
  *registered* victim is the rate-limit problem, [abuse-controls].)
- **L2 (fold-in).** `register` writes the handle projection first then the
  profile ([routes.rs:471](../server/src/routes.rs)); a crash between leaves a
  ghost `handles/{handle}.json` → `HandleTaken` forever.

## Current

Separate mutexes; delete reads profile then writes tombstone last; rotate/update
never re-GET under lock; cleanup walks only `handles/` → profile.

## Change

1. Serialize all three writers on **one per-uid lock**: `delete_profile`
   acquires `rotation_mu(uid)` for the whole wipe+tombstone; `update_profile`
   takes it too; `rotate_keys`/`update_profile` re-GET `profile.json` under the
   lock and abort (`404`/`409`) if absent or tombstoned before writing.
   (Alternative: S3 conditional writes if the backend ever supports them.)
2. Reorder delete for resumability: acquire the handle lock + write the
   tombstone **before** deleting `profile.json`; capture the handle from the
   token/projection so a retry after the profile is gone still proceeds; drive
   the wipe idempotently (uses the shared helper from [paginated-prefix-wipe]).
   M7's reorder (data prefixes first, `users/` last) applies to
   `cleanup::delete_user` here too.
3. M6: add a cleanup `inbox/`-keyed orphan sweep (list `inbox/` uid segments;
   any uid with no live profile/handle → wipe); gate `send` on recipient
   existence via the device-existence cache; validate `to_user` shape.
4. L2: reorder `register` so the claim-visible handle projection is written
   **last** (a crash then leaves only an orphaned profile under a never-returned
   uid; the handle stays free).

## Verify

- Fault-injection tests: delete-vs-rotate (tombstone survives, no resurrection,
  resolve `410` throughout); mid-wipe fault → retry both tombstones and
  completes erasure; post-deletion send → object swept by the orphan sweep.
- Tighten [i7](../docs/scenarios/invariants/i7-deletion-races.md): tombstone
  must survive a concurrent rotate/update; fix the "orphaned and cleaned up"
  claim.
