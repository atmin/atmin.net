# Invariants

Properties that must hold **under adverse conditions** — network faults,
retries, concurrent sync, partial failures, restores. Each invariant
corresponds to one Playwright spec under `web/e2e/invariants/*.spec.ts`.

> **Status:** starter document. When the list grows past ~8 invariants or
> a single section needs more than one mermaid diagram, split this file
> into `docs/scenarios/invariants/<name>.md` (one per invariant), mirroring
> the existing scenario layout. Update [README.md](./README.md) at the
> same time.

## Why this is separate from scenarios

Scenarios describe **what a user does**. Invariants describe **what must
remain true while faults happen**. The two overlap (a scenario implicitly
asserts an invariant) but the framing is different:

- A scenario reads: *"Alice registers, sends Bob a message, Bob sees it."*
- An invariant reads: *"For any send, every recipient sees exactly one
  copy, even under network retry and SSE drops."*

Tests written from invariants tend to construct faults deliberately and
assert on **all three state layers** (see below), where scenario tests
typically assert only on the UI.

## The three assertion layers

Every invariant test asserts at the layers where the invariant must hold.
A test passes only when all asserted layers agree; any permitted divergence
must be stated explicitly.

| Layer | What it represents | How to read it |
|---|---|---|
| **UI** | What the user sees | DOM queries via Playwright locators |
| **Local** | IndexedDB, session, device, message store | `page.evaluate()` against the IDB API |
| **Remote** | S3 object state | List/get against MinIO (test fixture) |

Helpers live in `web/e2e/invariants/helpers.ts`:

```ts
expectUI(page, { messageCount, messageTexts })
expectLocal(page, conversationId, { uniqueMsgIdCount, ordered })
expectRemote(s3, uid, { inboxLiveCount, inboxLiveMsgIds, archiveCount })
```

### Permitted divergence

Some invariants explicitly permit one layer to lag another. These must be
named in the invariant statement, e.g.:

- **Offline send rejected** — UI shows error, Local has no row, Remote
  has no object. *No divergence permitted.*
- **Queued for retry** *(if ever implemented)* — Local has row marked
  `pending`, Remote has no object. *Divergence permitted until next
  online tick.*

If a test discovers divergence that the invariant did not permit, it
fails — even if the UI "looks right".

## Test determinism

All invariant tests must be deterministic by default.

Deterministic fault construction — route interception, fixed delays,
explicit navigation sequences — is preferred. Randomized fault injection
is opt-in and must:

1. Print the seed before the test body (`console.log('CHAOS_SEED', seed)`).
2. Accept `CHAOS_SEED=<n>` from the environment to replay a specific run.
3. Be documented in the invariant's **Fault construction** section.

No current test uses randomized injection; this section is forward-looking
guidance for when chaos-style tests are added.

## Prioritisation

Ordered by blast radius if the invariant breaks in production.

| # | Invariant | Priority | Notes |
|---|---|---|---|
| I1 | Message identity is unique across layers | **P0** | Class of bug we already hit (see `useInboxSync`) |
| I2 | No lost messages under fault | **P0** | Silent data loss is the worst failure mode |
| I3 | Archive/live boundary is consistent | **P0** | Boundary correctness we cross every compaction |
| I4 | Restore-equivalence across devices | **P1** | Rarely exercised path, high stakes |
| I5 | Send outcomes are unambiguous | **P1** | No "ghost sent" states |
| I6 | Bad credential / corrupt backup fails legibly | **P1** | Wrong password rejected; corrupt blob → resilient restore + visible count |
| I7 | Account deletion races terminate cleanly | **P2** | Low probability, contained blast radius |
| I8 | Sync is idempotent | **P2** | Guard against accumulating side-effects on re-sync |
| I9 | Chain walker recovers history across N rotations | **P1** | Silent failure of multi-hop walk would surface only after real rotations |

---

## I1 — Message identity is unique across layers

**Statement.** For any `msg_id`, every device shows at most one bubble and
holds at most one IDB row — under any combination of:

- SSE `new_message` events delivered while a sync is in flight
- explicit refetch after `POST /v1/send`
- archive/live overlap during compaction (see I3)
- client-side retry of an idempotent `POST /v1/store/compact`

Remote uniqueness is strict **within** the live prefix and **within** each
archive object. Across live and archive, temporary duplication is permitted
only during the compaction window covered by I3. UI and Local deduplication
remain strict regardless.

**Fault construction.**

1. Register Alice and Bob.
2. Bob sends a burst to Alice while Alice's `GET /v1/store/list` is
   delayed (delay must outlast all burst sends so the list fires only
   after all messages are in S3 — see `LIST_DELAY_MS` in the spec).
3. Refresh Alice mid-burst.

**Assertions.**

- `expectUI(alicePage, { messageCount: BURST })`
- `expectLocal(alicePage, convId, { uniqueMsgIdCount: BURST, ordered: true })`
- `expectRemote`: no duplicate keys within `inbox/{uid}/live/`
- Order: monotonic by `msg_id` (ULID lexicographic) at UI and Local layers.

**Permitted divergence.** None at UI or Local. At Remote: temporary
live+archive overlap only during the compaction window (I3).

---

## I2 — No lost messages under fault

**Statement.**

- A send that reaches committed remote state (server returns 200 on
  `POST /v1/send`) must eventually be visible in the recipient's UI,
  Local, and Remote layers, exactly once.
- A send that is rejected must not appear as sent at any layer.

Faults in scope:

- recipient's SSE connection was down at send time
- recipient's next `GET /v1/store/list` first attempt times out
- a `PUT` to a presigned URL failed *after* the object was written
  server-side (ambiguous-success case)

**Fault construction.**

- *SSE drop*: kill Alice's `EventSource` between sends; verify reconcile
  on reconnect.
- *Ambiguous PUT*: use a fault-injection proxy (MinIO middleware) that
  writes the object then returns 502. Client retries; assert no duplicate
  and no loss.

**Assertions.**

- For every `msg_id` from a committed send: present in `expectUI`,
  `expectLocal`, `expectRemote` for Alice.
- No `msg_id` appears more than once at any layer.
- For every rejected send: absent from all three layers.

**Permitted divergence.** Remote may lead Local during the reconcile
window (bounded by the sync interval). UI never leads Local.

---

## I3 — Archive/live boundary is consistent

**Statement.** During and after compaction, every message is reachable
through exactly one path. No message is double-counted (live + archive),
no message is dropped at the boundary. Re-running sync after compaction
is idempotent: it produces no additional writes and does not change
message count or order.

**Fault construction.**

1. Generate enough messages to trigger one compaction.
2. Interleave a fresh device sync with an in-progress compaction.
3. Assert the new device sees every message exactly once.
4. Trigger sync again on the new device (no new messages sent); assert
   no change.

**Assertions.**

- `expectRemote(s3, uid, { liveCount: N, archiveCount: M })` where
  `N + M` equals total messages sent.
- `expectLocal(newDevice, convId, { uniqueMsgIdCount: N + M })`
- No `msg_id` appears in both `inbox/{uid}/live/` and any
  `inbox/{uid}/archive/` object (post-compaction).
- After a second sync pass: counts and order unchanged at all layers.

**Permitted divergence.** Mid-compaction, Remote may briefly hold a
message in both live and archive (until the live object is deleted).
Client-side dedup must absorb this; UI and Local must not reflect the
duplicate.

---

## I4 — Restore-equivalence across devices

**Statement.** Given the same handle and password, a second device
that comes online later converges to the same ordered message set and the
same decryptability status per `msg_id` as the first device. Convergence
is reached without manual intervention.

**Fault construction.**

1. Alice (device 1) chats with Bob; accumulate ≥1 compacted archive.
2. Alice adds device 2 *after* archives exist.
3. Device 2 completes initial sync; both devices receive a new live
   message.

**Assertions.**

- Both devices hold the same ordered `msg_id` list per conversation
  (`expectLocal` on both pages).
- Both devices can decrypt every message (decryptability status matches
  per `msg_id`).
- `expectUI(device1) === expectUI(device2)` on the same route.
- Both devices receive the post-restore live message; `expectRemote`
  shows one live object addressed to Alice's inbox.

**Permitted divergence.** Device 2's IDB may lag during the initial
backfill. Window is bounded by `GET /v1/store/list` duration; after that,
no divergence permitted.

---

## I5 — Send outcomes are unambiguous

**Statement.** Every send attempt resolves into exactly one of:
`{ sent, rejected }`. There is no UI state that implies "in flight" or
"sent" without a corresponding Local row and Remote object reachable by
normal inbox sync.

A rejected send must not produce Remote objects reachable by a normal
inbox sync. Unreachable orphans (e.g. from a partial server-side write
that was never indexed) are out of scope for this invariant.

(`queued` is intentionally absent — see
[Offline mode § Sending while offline](./offline-mode.md#sending-while-offline)
and ADR-0002 for the Megolm ratchet rationale.)

**Fault construction.**

- *Offline send*: kill network, attempt send. Expect immediate
  rejection.
- *Online send with `POST /v1/send` 500*: server returns error after
  ciphertext was committed by client. Expect explicit failure UI; Local
  must not show a "sent" row.

**Assertions.**

- For every rejected send: no Local row, no Remote object reachable via
  `inbox/{uid}/live/` or `inbox/{uid}/archive/`, UI shows error.
- For every accepted send: Local row present, Remote object present,
  UI shows "sent".
- No state where UI says "sent" but Local/Remote disagree.

**Permitted divergence.** None.

---

## I6 — Bad credential / corrupt backup fails legibly

**Statement.** The two failure modes are distinct, and neither is silent:

- A **wrong password** is rejected at login — no session is established,
  no local session state is written.
- A **correct password against a corrupt/undecryptable key-backup blob**
  does *not* block login. Restore is resilient: it recovers every blob it
  can, counts the ones it cannot, and surfaces that count to the user
  ("N conversations' history couldn't be restored"). One bad blob must
  not cost the user every *other* conversation — but the loss is shown,
  not swallowed.

**Fault construction.**

- *Wrong secret*: register Alice, then attempt second-device login with
  a different password.
- *Corrupt ciphertext*: register Alice and receive ≥1 message (so a
  key-backup blob exists), then on a fresh device corrupt that
  `keys/{uid}/live/{session_id}` blob's ciphertext before logging in with
  the *correct* password.

**Assertions.**

- *Wrong secret*: login does not succeed (stays on `/login` with an
  error); no session token is persisted; IDB holds no restored session.
- *Corrupt blob*: login succeeds; the restore-warning signal
  (`[data-testid="restore-warning"]`) appears with the failed count; the
  client does not crash; conversations whose blobs were intact still
  restore.
- Remote state is unchanged in both cases (the fault is read-side).

**Permitted divergence.** A corrupt blob is skipped, not repaired — that
conversation's history stays absent on this device until a good copy is
restored. The user is told; it is not silent.

---

## I7 — Account deletion races terminate cleanly

**Statement.** A `DELETE` initiated while a sync is in flight resolves
deterministically: either the sync completes against pre-delete state and
is then invalidated on the next request, or it aborts mid-flight without
crashing the client.

**Fault construction.**

1. Alice on device 1 starts `DELETE /v1/profile`.
2. Alice on device 2, online concurrently, is mid-sync.
3. Bob sends a message during the window.

**Assertions.**

- Device 2's in-flight sync either completes (returns 200) or fails with
  a recognised auth error. No uncaught exceptions, no infinite retry.
- After deletion settles: device 2 receives 401 on the next request, is
  logged out, IDB is cleared.
- Remote: all `users/{uid}/`, `inbox/{uid}/`, `keys/{uid}/`, and
  `media/{uid}/` objects are absent. `handles/{handle}.json` is *not*
  absent — deletion replaces it with a 30-day cooldown tombstone
  (custom-handles / ADR-0013); resolve returns `410`, not `404`.
- Bob's outbound `POST /v1/send` during the window: either accepted
  (object orphaned and cleaned up) or rejected — must be one of the two,
  never silently lost.

**Permitted divergence.** Brief window where Remote is partially deleted
while Local still reflects logged-in state on device 2. Window bounded by
device 2's next request.

---

## I8 — Sync is idempotent

**Statement.** Re-running sync any number of times when the cursor is
unchanged (no new remote objects since the last successful sync) does not
alter UI, Local message count, message ordering, conversation summaries,
contact list, or per-`msg_id` decryptability status.

Carve-outs: background processes that legitimately run on sync
(session-key rotation, quota recalculation) may update their own state
without violating this invariant. Only the message and conversation layers
are in scope.

**Fault construction.**

1. Alice and Bob exchange N messages; all syncs settle.
2. Trigger sync on Alice's page K additional times (navigate away and
   back, or call the sync hook directly via `page.evaluate`).
3. Assert no change after each additional sync.

**Assertions.**

- `expectUI` count and order unchanged after each additional sync.
- `expectLocal` `uniqueMsgIdCount` and `orderedMonotonically` unchanged.
- `expectRemote` live and archive key sets unchanged (no new compaction
  triggered, no objects written).
- Conversation summary (last message, count) unchanged.

**Permitted divergence.** None.

---

## I9 — Chain walker recovers history across N rotations

**Statement.** For any sequence of credential rotations
(`kv = 1 → 2 → … → N`), a fresh device whose keys are derived at
`kv = N` recovers every message ever sent to the account by walking
`keys/{uid}/key_chain.json`. UI, Local, and Remote layers reflect the
same complete message set, in send order, with no duplicates and no
silent decryption failures.

Scenario tests cover one rotation; this invariant generalises to
`N ≥ 2`. The chain walker has to traverse strictly more than one link
or the test passes trivially.

**Fault construction.**

1. Alice registers (kv = 1) with password `pw_1`. Bob registers.
2. Bob → Alice **"era-1"** while Alice is at kv = 1.
3. Alice rotates to `pw_2` (kv = 2). Bob → Alice **"era-2"**.
4. Alice rotates to `pw_3` (kv = 3). Bob → Alice **"era-3"**.
5. A clean-IDB device signs in with `pw_3`. This is the fault
   surface: the device has no prior backup keys, so every
   pre-rotation session-key envelope (`v: 1`, `v: 2`) must be
   decrypted by walking the chain from kv = 3 back.

**Assertions.**

- `expectUI(fresh, { messageCount: 3, messageTexts: ['era-1','era-2','era-3'] })`.
- `expectLocal(fresh, convId, { uniqueMsgIdCount: 3, ordered: true })`.
- `expectRemote` — `inbox/{uid}/{live,archive}/` is non-empty; no
  duplicate keys within the live prefix. A precise per-era count is
  intentionally *not* asserted: post-compaction, all three messages
  may collapse into a single archive bundle, and the Local layer
  already proves end-to-end recoverability.
- `keys/{uid}/key_chain.json` contains exactly the links
  `[{from:1,to:2},{from:2,to:3}]`, in that order.

**Permitted divergence.** None at any layer on the fresh device. The
live/archive split on the inbox is implementation-dependent (depends
on whether compaction fired during the test) — only the total count
and the absence of duplicates are invariant.

---

## Adding a new invariant

1. Add a row to the prioritisation table above.
2. Append a section using the template (Statement, Fault construction,
   Assertions, Permitted divergence).
3. Add `web/e2e/invariants/<short-name>.spec.ts` that constructs the
   fault and asserts at the named layers.
4. If the invariant introduces a new helper or fault-injection mechanism,
   document it in `web/e2e/invariants/helpers.ts`.
5. When this file passes ~8 invariants or any section grows beyond one
   diagram, split into `docs/scenarios/invariants/<name>.md` and turn
   this file into an index.
