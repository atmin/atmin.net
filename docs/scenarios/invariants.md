# Invariants

Properties that must hold **under adverse conditions** — network faults,
retries, concurrent sync, partial failures, restores. Each invariant
corresponds to one Playwright spec under `web/e2e/invariants/*.spec.ts`.

> **Status:** starter document. When the list grows past ~6 invariants or
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

Helpers (to be added under `web/e2e/invariants/helpers.ts`):

```ts
expectUI(page, { messages: [...] })        // DOM-level
expectLocal(page, { idbMessages: [...] }) // IDB-level
expectRemote(s3, uid, { inboxLive: [...] }) // S3-level
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

## Prioritisation

Ordered by blast radius if the invariant breaks in production.

| # | Invariant | Priority | Notes |
|---|---|---|---|
| I1 | No duplicate visible messages | **P0** | Class of bug we already hit (see `useInboxSync`) |
| I2 | No lost messages under fault | **P0** | Silent data loss is the worst failure mode |
| I3 | Archive/live boundary is consistent | **P0** | Boundary correctness we cross every compaction |
| I4 | Restore-equivalence across devices | **P1** | Rarely exercised path, high stakes |
| I5 | Send outcomes are unambiguous | **P1** | No "ghost sent" states |
| I6 | Bad backup secret fails cleanly | **P1** | Distinguish from corrupted ciphertext |
| I7 | Account deletion races terminate cleanly | **P2** | Low probability, contained blast radius |

---

## I1 — No duplicate visible messages

**Statement.** For any `msg_id`, every device shows at most one bubble,
holds at most one IDB row, and (within retention) the recipient inbox
holds at most one S3 object — under any combination of:

- SSE `new_message` events delivered while a sync is in flight
- explicit refetch after `POST /v1/send`
- archive/live overlap during compaction (see I3)
- client-side retry of an idempotent `POST /v1/store/compact`

**Fault construction.**

1. Register Alice and Bob.
2. Bob sends a 100-message burst to Alice.
3. Throttle Alice's `GET /v1/store/list` to 2× the SSE arrival rate to
   force concurrent sync + SSE handling.
4. Refresh Alice mid-burst.

**Assertions.**

- `expectUI(alicePage, { messageCount: 100 })`
- `expectLocal(alicePage, { uniqueMsgIds: 100 })`
- `expectRemote(s3, aliceUid, { inboxLive: 100 })` *(pre-compaction)*
- Order: monotonic by `msg_id` (ULID lexicographic) at every layer.

**Permitted divergence.** None.

---

## I2 — No lost messages under fault

**Statement.** Every successful `POST /v1/send` is eventually reflected in
the recipient's UI, Local, and Remote layers, even if:

- the recipient's SSE connection was down at send time
- the recipient's next `GET /v1/store/list` first attempt times out
- a `PUT` to a presigned URL failed *after* the object was written
  server-side (ambiguous-success case)

**Fault construction.**

- *SSE drop*: kill Alice's `EventSource` between sends; verify reconcile
  on reconnect.
- *Ambiguous PUT*: use a fault-injection proxy (MinIO middleware) that
  writes the object then returns 502. Client retries; assert no duplicate
  and no loss.

**Assertions.**

- For every `msg_id` Bob sent: present in `expectUI`, `expectLocal`,
  `expectRemote` for Alice.
- No `msg_id` appears more than once at any layer.

**Permitted divergence.** Remote may lead Local during the reconcile
window (bounded by the sync interval). UI never leads Local.

---

## I3 — Archive/live boundary is consistent

**Statement.** During and after compaction, every message is reachable
through exactly one path. No message is double-counted (live + archive),
no message is dropped at the boundary.

**Fault construction.**

1. Generate enough messages to trigger one compaction.
2. Interleave a fresh device sync with an in-progress compaction.
3. Assert the new device sees every message exactly once.

**Assertions.**

- `expectRemote(s3, uid, { liveCount: N, archiveCount: M })` where
  `N + M` equals total messages sent.
- `expectLocal(newDevice, { uniqueMsgIds: N + M })`
- No `msg_id` appears in both `inbox/{uid}/live/` and any
  `inbox/{uid}/archive/` object.

**Permitted divergence.** Mid-compaction, Remote may briefly hold a
message in both live and archive (until the live object is deleted).
Client-side dedup must absorb this; UI/Local must not.

---

## I4 — Restore-equivalence across devices

**Statement.** Given the same handle and backup mnemonic, a second device
that comes online later converges to the same decrypted state as the
first device. Convergence is reached without manual intervention.

**Fault construction.**

1. Alice (device 1) chats with Bob; accumulate ≥1 compacted archive.
2. Alice adds device 2 *after* archives exist.
3. Device 2 completes initial sync; both devices receive a new live
   message.

**Assertions.**

- `expectLocal(device1, …) === expectLocal(device2, …)` for chat list,
  per-chat message lists, and contact list.
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
"sent" without a corresponding Local row and Remote object.

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

- For every rejected send: no Local row, no Remote object, UI shows
  error.
- For every accepted send: Local row present, Remote object present,
  UI shows "sent".
- No state where UI says "sent" but Local/Remote disagree.

**Permitted divergence.** None.

---

## I6 — Bad backup secret fails cleanly

**Statement.** Attempting to log in with an incorrect mnemonic fails
explicitly. No IDB writes, no partial state, no silent fall-through.
Separately, a correct mnemonic against corrupted ciphertext (e.g., a
truncated key backup object) fails with a different, distinguishable
error.

**Fault construction.**

- *Wrong secret*: register Alice, then attempt second-device login with
  a different mnemonic.
- *Corrupt ciphertext*: register Alice, mutate a key-backup S3 object
  to truncate the GCM tag, then attempt restore with the correct
  mnemonic.

**Assertions.**

- Both cases: no IDB writes during the failed attempt.
- Two distinct user-visible error messages (or error codes) — wrong
  secret vs. corrupted object.
- Remote state unchanged in both cases.

**Permitted divergence.** None.

---

## I7 — Account deletion races terminate cleanly

**Statement.** A `DELETE` initiated while a sync is in flight resolves
deterministically: either the sync completes against pre-delete state and
is then invalidated on the next request, or it aborts mid-flight without
crashing the client.

**Fault construction.**

1. Alice on device 1 starts `DELETE /v1/account`.
2. Alice on device 2, online concurrently, is mid-sync.
3. Bob sends a message during the window.

**Assertions.**

- Device 2's in-flight sync either completes (returns 200) or fails with
  a recognised auth error. No uncaught exceptions, no infinite retry.
- After deletion settles: device 2 receives 401 on the next request, is
  logged out, IDB is cleared.
- Remote: all `users/{uid}/`, `inbox/{uid}/`, `keys/{uid}/`,
  `media/{uid}/`, `handles/{handle}.json` objects are absent.
- Bob's outbound `POST /v1/send` during the window: either accepted
  (object orphaned and cleaned up) or rejected — must be one of the two,
  never silently lost.

**Permitted divergence.** Brief window where Remote is partially deleted
while Local still reflects logged-in state on device 2. Window bounded by
device 2's next request.

---

## Adding a new invariant

1. Add a row to the prioritisation table above.
2. Append a section using the template (Statement, Fault construction,
   Assertions, Permitted divergence).
3. Add `web/e2e/invariants/<short-name>.spec.ts` that constructs the
   fault and asserts at the named layers.
4. If the invariant introduces a new helper or fault-injection mechanism,
   document it in `web/e2e/invariants/helpers.ts`.
5. When this file passes ~6 invariants or any section grows beyond one
   diagram, split into `docs/scenarios/invariants/<name>.md` and turn
   this file into an index.
