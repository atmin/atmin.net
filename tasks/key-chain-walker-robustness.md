# Key-chain walker: try-until-decrypt

> A rotation retry can silently brick all pre-rotation history. **Audit
> findings:** H1, L1 · **Priority: P0** (silent, permanent data loss).

## Why it matters

`resolveBackupKey` picks the chain link by **append order**, not by which link
actually decrypts:

```
const link = chain.links.find(l => l.to === version && l.from === version - 1);
```
([key-chain.ts:157](../web/src/lib/key-chain.ts)) — then AES-GCM-decrypts it
unconditionally at :168, throwing on failure.

**H1 (deterministic single-device retry).** At `kv=3`, chain `[1→2, 2→3]`, a
password change appends `{3→4}` wrapping the old key under a fresh-salt `K4a`
**before** POSTing `/v1/rotate-keys`
([useRotateKeys.ts:126-151](../web/src/hooks/useRotateKeys.ts)). The POST fails
transiently (not a `KeyVersionStaleError`, so no session swap). The user
re-submits: a new salt yields `K4b`, a **second** `{3→4}` link is appended, and
this POST commits (server → v4, device holds `K4b`). Restoring any `v ≤ 3` blob
later: `.find` returns the `K4a` link, decrypt with `K4b` fails the GCM tag, and
it **throws** — the correct `K4b` link is never tried. Every `v ≤ 3` session key
and `contacts.json` becomes undecryptable on **every** device.
`restoreContacts` has no surrounding try/catch, so the throw aborts the *entire*
contact restore. The "harmless orphan link" comment
([useRotateKeys.ts:123-124](../web/src/hooks/useRotateKeys.ts)) is wrong.

**L1 (fold-in).** The client mints a fresh `request_id` every submit
([useRotateKeys.ts:138](../web/src/hooks/useRotateKeys.ts)), so the server's
idempotency record is dead code for the web client; a lost-response retry hits
`401 key_version_stale` on the profile read and hard-logs-out (recoverable — new
password works, chain walk restores).

## Current

Single `.find` + unconditional decrypt; `appendChainLink` does not dedup; the
link is appended before the POST commits.

## Change

1. `resolveBackupKey`: iterate **all** links matching `(to === v && from === v-1)`,
   attempt AES-GCM decrypt on each, accept the first that succeeds (the GCM tag
   authenticates the correct link); throw "missing link" only if none decrypts.
2. `appendChainLink`: dedup by `(from, to)`; and/or append the link only **after**
   the rotate POST commits (rotation is idempotent on `request_id`).
3. L1: on `KeyVersionStaleError` with `current === newKV`, treat the rotation as
   succeeded and re-derive the session locally instead of hard logout.
4. Fix the misleading orphan-link comment.

## Verify

- Ships **[I15](../docs/scenarios/invariants/i15-decryptability-closure.md)
  path B** and **[I16](../docs/scenarios/invariants/i16-rotation-idempotent-replay.md)**
  as regression guards.
- `key-chain.test.ts`: two colliding `{3→4}` links wrapping different keys →
  resolve returns the one that decrypts.
- e2e: rotation-retry (two colliding links) → fresh device recovers every era.
