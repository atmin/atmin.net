# Credential overhaul 3/5 — backup-key chain + envelope versioning

Part of the credential-overhaul task group:

1. [credential-registration](credential-registration.md) — registration UI + Argon2id + salt
2. [credential-rotate-endpoint](credential-rotate-endpoint.md) — server `POST /v1/rotate-keys`
3. **credential-backup-chain** (this file) — `key_chain.json` + envelope versioning
4. [credential-rotate-ui](credential-rotate-ui.md) — settings UI for "change password"
5. [credential-multi-device-cutoff](credential-multi-device-cutoff.md) — handle `401 key_version_stale`

## Motivation

After task 2 lands, the server can rotate keys but every existing
backed-up Megolm session key + the contacts blob were encrypted with
the *old* backup key. On a new device login after rotation, those
historical objects are undecryptable. This task adds the lazy
chain mechanism: a tiny `keys/{uid}/key_chain.json` carrying old
backup keys each wrapped by their successor, plus a `v` field on
every envelope so the reader knows which key to use.

Depends on task 2 only for the `key_version` concept. Can land in
parallel with task 1.

Specs: [ADR-0012](../docs/decisions/adr-0012-backup-secret-rotation.md)
(*Backup migration*),
[mvp-v0.1.md#key-chain](../docs/specs/mvp-v0.1.md#key-chain),
[mvp-v0.1.md#key-backup-objects](../docs/specs/mvp-v0.1.md#key-backup-objects).

## Current state

- [key-backup.ts:41-46](../web/src/lib/key-backup.ts) writes
  `{msg_id, session_id, iv, ciphertext}` for each session-key blob.
  No `v` field; one implicit version.
- [key-backup.ts:71-73](../web/src/lib/key-backup.ts)
  parses the blob as `KeyBackupEntry`. Single backup-key path.
- [contact-backup.ts:38-43](../web/src/lib/contact-backup.ts) writes
  `{iv, ciphertext}`. Same single-version assumption.
- [db.ts](../web/src/lib/db.ts) has object stores for keys
  (`KEYS_STORE`), messages, conversations, etc. No store for
  per-version backup keys.
- No `keys/{uid}/key_chain.json` read/write logic exists. The path
  is reserved in [mvp-v0.1.md#storage-layout](../docs/specs/mvp-v0.1.md#storage-layout-s3-keys)
  but no code touches it.

## Architecture constraints

- All envelope crypto stays in `lib/` ([lint-architecture.sh](../web/scripts/lint-architecture.sh)).
- IndexedDB schema migrations live in [db.ts](../web/src/lib/db.ts)
  `onupgradeneeded`. New stores need a version bump.
- Archives are CBOR arrays of envelopes; each entry self-describes
  its `v`. Mixed-version archives are valid by design (per the
  [spec update](../docs/specs/mvp-v0.1.md#key-backup-objects)).

## Change

### 1. Envelope schema + helpers

New [web/src/lib/key-backup-envelope.ts](../web/src/lib/key-backup-envelope.ts):

```ts
export interface KeyBackupEnvelopeV2 {
    v: number;
    msg_id?: string;
    session_id: string;
    iv: string;          // base64
    ciphertext: string;  // base64
}

export function wrapKeyBackupEnvelope(
    v: number,
    sessionId: string,
    iv: Uint8Array,
    ciphertext: Uint8Array,
): KeyBackupEnvelopeV2 { /* ... */ }

export function parseKeyBackupEnvelope(
    raw: unknown,
): { v: number; sessionId: string; iv: Uint8Array; ciphertext: Uint8Array } {
    // Accept legacy {iv, ciphertext} (no v) → treat as v: 1
    // Accept v2 {v, session_id, iv, ciphertext}
    // Throw on malformed
}
```

The function exists separately from `key-backup.ts` so it can also
be used from `contact-backup.ts` (which uses a different upper-level
shape but the same envelope semantics).

### 2. `contacts.json` envelope

[contact-backup.ts](../web/src/lib/contact-backup.ts) — change the
upload to write `{v: currentKv, iv, ciphertext}` and the download to
accept both v1-shaped (no `v`) and v2 blobs. The current/old backup
key selection mirrors the key-backup path (see step 4).

### 3. Key chain reader/writer

New [web/src/lib/key-chain.ts](../web/src/lib/key-chain.ts):

```ts
export interface KeyChainLink {
    from: number;
    to: number;
    iv: string;          // base64
    ciphertext: string;  // base64
}

export interface KeyChain {
    links: KeyChainLink[];
}

/** Encrypt prevKey by toKey and return the new link. */
export async function buildChainLink(
    fromVersion: number,
    toVersion: number,
    prevKey: CryptoKey,
    toKey: CryptoKey,
): Promise<KeyChainLink>;

/** Append link, upload key_chain.json via storePresign. */
export async function appendChainLink(
    token: string,
    userId: string,
    link: KeyChainLink,
): Promise<void>;

/** Fetch the current chain (returns {links: []} if 404). */
export async function fetchChain(
    token: string,
    userId: string,
): Promise<KeyChain>;

/**
 * Walk the chain from currentVersion back to targetVersion.
 * Returns the backup key for targetVersion.
 * Memoizes resolved keys per (userId, version) in IDB.
 */
export async function resolveBackupKey(
    token: string,
    userId: string,
    currentKey: CryptoKey,
    currentVersion: number,
    targetVersion: number,
    chain: KeyChain,
): Promise<CryptoKey>;
```

The `ciphertext` in a link is `AES-256-GCM(toKey, plaintext = rawBytes(fromKey))`.
Wrapping a `CryptoKey` requires `crypto.subtle.exportKey('raw', ...)`,
which in turn requires the key to be `extractable: true`. The
backup key today is non-extractable
([crypto.ts:156-162](../web/src/lib/crypto.ts)), and it should stay
that way for routine operation — XSS during a session must not be
able to exfiltrate the AES key that decrypts the entire key-backup
history.

Per [ADR-0012](../docs/decisions/adr-0012-backup-secret-rotation.md#backup-migration-lazy),
the chain mechanism uses a **rotation-only extractable** path. The
normal `deriveKeys(secret)` continues to return a non-extractable
backup key. A new variant `deriveKeys(secret, { extractable: true })`
is invoked **only during the rotation flow** — the user has just
re-entered their current password to compute the continuity
signature anyway, so the old backup key is rederived as extractable
purely to produce the chain link, then dropped. The persisted
at-rest backup key in IDB is always non-extractable.

Implementation:

- [crypto.ts](../web/src/lib/crypto.ts) `deriveKeys` gains an
  optional `{ extractable?: boolean }` second argument. Default
  `false` preserves current behaviour for all existing callers.
- The rotation hook (task 4) calls `deriveKeys(oldSecret, { extractable: true })`
  for the old-key derivation only. The new key is derived as
  non-extractable.
- `buildChainLink` consumes the extractable `CryptoKey`s via
  `subtle.exportKey('raw', ...)` then `subtle.encrypt`. The
  extractable copies are local variables, never stored.

### 4. IndexedDB schema bump for resolved keys

[db.ts](../web/src/lib/db.ts):

- Bump `DB_VERSION` by one.
- In `onupgradeneeded`, create object store `backup_keys_by_version`
  keyed by `[userId, version]` storing a `CryptoKey`. The
  `onupgradeneeded` handler **must run idempotently** on top of any
  prior version — existing object stores (`KEYS_STORE`,
  `messages`, `conversations`, `contacts`, `megolm_outbound`,
  `megolm_inbound`, `megolm_key_shares`, `sync_cursors`) must
  survive the upgrade with their data intact. The existing pattern
  in [db.ts](../web/src/lib/db.ts) (per-version `if` blocks against
  `event.oldVersion`) is what should be extended; do not rewrite
  the migration ladder.
- Add `putBackupKey(userId, version, key)` and
  `getBackupKey(userId, version)` helpers.

`resolveBackupKey` populates this store as it walks; subsequent
reads of the same `(userId, version)` are O(1).

### 5. Versioned write path

[key-backup.ts:32-53](../web/src/lib/key-backup.ts) `backupSessionKey`:

- Take the current `keyVersion` as a parameter (caller provides it
  from the session).
- Wrap the ciphertext with `{v: keyVersion, ...}` via
  `wrapKeyBackupEnvelope`.
- Existing callers ([useChatSend](../web/src/hooks/useChatSend.ts),
  inbox-sync, etc.) updated to pass `session.keyVersion`. The
  `Session` interface in [auth.ts](../web/src/lib/auth.ts) gains a
  `keyVersion: number` field; on session load, `keyVersion` is
  pulled from `profile.json` (or defaulted to `1` for legacy).

### 6. Versioned read path

[key-backup.ts:55+](../web/src/lib/key-backup.ts) `restoreSessionKeys`:

```ts
// Pseudo-flow:
const chain = await fetchChain(token, userId);
const memo = new Map<number, CryptoKey>();
memo.set(currentVersion, currentBackupKey);

for (const blob of liveBlobs.concat(archiveEntries)) {
    const env = parseKeyBackupEnvelope(blob);
    let key = memo.get(env.v);
    if (!key) {
        key = await resolveBackupKey(
            token, userId, currentBackupKey, currentVersion, env.v, chain,
        );
        memo.set(env.v, key);
    }
    await restoreEntry(env, key, sessionManager);
}
```

Archive entries (CBOR-decoded) each carry their own `v`. The reader
dispatches per-entry. Order independence: archives can mix v1 and
v2 entries when a rotation lands between compactions, and that's
fine.

### 7. Optional: prefetch the chain on session load

When `loadSession` succeeds and the account is at `key_version > 1`,
fire-and-forget `fetchChain` to warm the IDB memo store. Reduces
first-read latency on a freshly logged-in device that has historical
backups. Not blocking; nice-to-have.

### 8. Compaction implication (documentation only)

No code change to compaction itself — it already operates on opaque
bytes (server-side CBOR concatenation, see
[mvp-v0.1.md#compact](../docs/specs/mvp-v0.1.md#compact)). The
reader handles mixed-version archives. Document this in the
`restoreSessionKeys` jsdoc so a future contributor doesn't try to
"fix" the heterogeneity.

## Out of scope

- Triggering the actual `appendChainLink` call from rotation — that's
  task 4 (`credential-rotate-ui`), which orchestrates rotation as a
  whole.
- Decrypting `media/{uid}/{ulid}` after rotation — media envelopes
  use per-upload random keys carried inside the Megolm-encrypted
  envelope, so they are unaffected by backup-key rotation.
- Migrating in-the-wild v1 blobs to v2 envelopes. Lazy by design;
  legacy blobs keep their shape and are read on the `v: 1` path
  forever (or until a future cleanup task).

## Verify

`make fmt lint test` clean.

**Vitest:**

- `key-backup-envelope.test.ts`:
  - `wrapKeyBackupEnvelope` round-trips with `parseKeyBackupEnvelope`.
  - `parseKeyBackupEnvelope` accepts legacy `{iv, ciphertext}` →
    `v: 1`.
  - `parseKeyBackupEnvelope` accepts v2 `{v, session_id, iv, ciphertext}`.
  - Throws on missing `iv` / `ciphertext`.

- `key-chain.test.ts`:
  - `buildChainLink` + AES round-trip: encrypt `prevKey` bytes with
    `toKey`, then decrypt the link's `ciphertext` with `toKey` and
    confirm bytes match.
  - `resolveBackupKey` with a one-link chain (current=2, target=1):
    walks one step, returns a working `CryptoKey` (can decrypt a
    blob encrypted with key v1).
  - `resolveBackupKey` with a two-link chain (current=3, target=1):
    walks two steps.
  - `resolveBackupKey` memoizes: second call for the same target
    does not re-decrypt the chain.
  - **Broken chain**: `links: [{from: 1, to: 2}, {from: 4, to: 5}]`
    missing 2→3 and 3→4; resolving target=3 throws a clear error
    (rather than silently returning a wrong key).
  - **Target >= current**: `resolveBackupKey(current=2, target=2)`
    returns the current key without walking. `target=3` (greater
    than current) throws — caller error.
  - `fetchChain` returns `{links: []}` on 404 (no chain yet).

- `crypto.test.ts` (extend):
  - `deriveKeys(secret)` (default) — `backupKey.extractable === false`.
  - `deriveKeys(secret, { extractable: true })` —
    `backupKey.extractable === true`, and
    `subtle.exportKey('raw', backupKey)` returns the expected
    32 bytes.

- `key-backup.test.ts` (updated):
  - `backupSessionKey` writes a v2-shaped envelope when `keyVersion: 2`.
  - `restoreSessionKeys` decrypts a v1-shaped legacy blob using the
    v1 backup key (looked up via the chain).
  - `restoreSessionKeys` decrypts a mixed-version archive
    (CBOR array with entries at `v: 1` and `v: 2`).

- `contact-backup.test.ts`:
  - Upload wraps with current `v`.
  - Restore accepts both v1-shaped and v2-shaped blobs.

- `db.test.ts` (extend) — IDB schema migration:
  - Open the database at the prior `DB_VERSION` (one less than the
    new value). Seed each existing object store with a representative
    row (one Megolm outbound session, one contact, one stored
    message, one sync cursor).
  - Close and re-open at the new `DB_VERSION`.
  - Assert every seeded row is still readable after the upgrade.
  - Assert the new `backup_keys_by_version` store exists and is
    empty.
  - Cover the fresh-install path too (no prior version) — the new
    store is created and all existing stores are created in the
    same go.

**Manual:**

- After task 4 ships, this task's correctness is validated by the
  end-to-end rotation test there: rotate, log in on a fresh device
  with the new password, see historical messages decrypt via the
  chain. Until then, the unit tests cover the moving parts.

**No server changes** — `keys/{uid}/key_chain.json` lives under the
existing `keys/{user_id}/` prefix that the caller's token already
authorises.
