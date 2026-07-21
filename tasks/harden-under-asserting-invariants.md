# Harden under-asserting invariants

> Several invariant e2e tests assert less than their doc promises — a
> "fail-everything" implementation keeps them green. **Priority: Medium**
> (test-only, high leverage). Also writes the remaining new specs.

## Why it matters

The invariant framework (three-layer UI/Local/Remote assertions) is strong, but
the guard is only as good as what the spec actually checks. Today a regression
that broke the named property would pass these:

| Invariant | Doc promises | Spec actually checks |
|---|---|---|
| **I11** (calls key isolation *"load-bearing"*) | no prior account's **private key** survives | `expectLocal` opens only the `messages` store — never `keys`/`backup_keys_by_version` |
| **I10** | a failed backup is queued + re-attempted, "never silently dropped" | only the object-name-safe happy path; the retry queue is never forced to enqueue or drain |
| **I6** | recover intact blobs, **count** only the bad ones | corrupt-blob test mangles *every* blob (fail-everything passes); mixed good+bad absent; wrong-password check is localStorage-only; Remote never checked |
| **I7** | `inbox/` deleted; device-2 **IDB wiped**; in-flight sync resolves cleanly | asserts only `users/`/`keys/`/`media/` empty (never `inbox/`); `/login`+null token (never IDB); never the sync outcome or page errors |
| **I2** | committed `msg_id` **present** in S3 | Remote downgraded to a dedup/uniqueness check; presence never asserted; list-failure test omits Remote |
| **I8** | re-sync doesn't alter the **contact list** | no contact assertion at all |
| **I1** | fault step: "refresh Alice **mid-burst**" | reload happens only *after* the burst settles; mid-flight reload + idempotent-compact-retry never constructed |

## Change

Strengthen each spec to assert what its doc promises:
- **I11:** open the `keys` / `backup_keys_by_version` stores; assert none of A's
  private keys survive into B's session.
- **I10:** force a backup PUT to fail, assert the pending-backup queue enqueues,
  then drains on the next sync (overlaps [I15]).
- **I6:** mixed good+bad blobs → intact conversations restore, the bad ones are
  *counted*; assert no IDB session on wrong password; assert Remote unchanged.
- **I7:** assert `inbox/` empty, device-2 IDB wiped, and the in-flight sync
  resolves to `200`-or-recognized-auth-error with no uncaught exception.
- **I2:** assert committed `msg_id`s are **present** in S3 (not just unique);
  cover the list-failure path at the Remote layer.
- **I8:** add a contact-list assertion.
- **I1:** construct the true mid-burst reload and the idempotent-compact-retry
  fault.

Also write the remaining new spec:
- **[I17](../docs/scenarios/invariants/i17-amendment-authorization.md)** —
  amendment applies only from its author (forge a cross-`from_user` amendment
  via `putObject`; assert it's inert).

(I12/I13 already implemented; I14 ships with [harden-sender-controlled-fields];
I16 and I15 path B shipped with the key-chain walker fix (I15 path A, the
queue-drain spec, is still open); I18 with [paginated-prefix-wipe].)

## Verify

Each hardened spec fails against a stub that breaks its named property (e.g. an
impl that skips the DB wipe must fail I11; one that never drains the queue must
fail I10).

## Further coverage gaps (backlog, lower priority)

Preserved from the audit's testing section so they aren't lost; pick up
opportunistically or when touching the relevant surface.

- **Missing invariant — handle-claim concurrency:** a real concurrent
  same-handle race proving exactly one winner (loser gets `handle_taken` via
  GET-then-PUT-under-lock). The existing 503 test forces the timeout externally.
- **Server-side:** concurrent media-quota reservation accounting (lost-update
  under the per-user mutex); concurrent same-`request_id` rotation replay;
  compaction-vs-concurrent-send (the list/get `NotFound`-skip branch); missing
  `400`/`401` cases (compact request validation, `delete_object` missing token,
  `add`/`revoke_device` malformed body, resolve corrupt-tombstone → `404`); the
  SSE `?token=` query-param auth **success** path.
- **Client-side adverse-condition ingest:** IndexedDB quota-exceeded / tx abort;
  corrupt/truncated inputs (bad-JSON live envelope, `cborDecode` throw on an
  archive, Megolm `from_pickle` throw, known-session decrypt failure);
  `read-markers.ts` corrupt-remote-blob / upload-failure ("leaves local intact,
  next sync flushes"); `inbox-sync` must still fire inbox listeners after a
  `syncReadMarkers` rejection.
- **Scenario ↔ e2e:** server 5xx on the read/sync path while online (currently
  swallowed — stale data, no indicator); a dedicated account-recovery e2e
  (revoke the lost device *from* the recovered one; new Megolm session the peer
  decrypts); the count-driven session-rotation trigger end-to-end; outbound
  ratchet continuity after invalid-token re-auth; avatar upload / partial
  profile update.

(`restoreSessionKeys` broken-chain → shipped (key-chain walker try-until-decrypt); SSE
permanent-disconnect / mid-session 401 → [sse-resilience]; `markConversationRead`
local concurrency → [harden-sender-controlled-fields] via I14; rotation-record
24h TTL sweep → spec-code-drift.)
