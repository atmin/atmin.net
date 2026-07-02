# Invariants

Properties that must hold **under adverse conditions** — network faults,
retries, concurrent sync, partial failures, restores. Each invariant is one
file in this directory and corresponds to (at most) one Playwright spec under
`web/e2e/invariants/*.spec.ts`.

This directory was split out of a single `invariants.md` once the list passed
~8 entries, mirroring the per-file [scenario](../README.md) layout.

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

Ordered by blast radius if the invariant breaks in production. **Spec**
links the implementing Playwright file, or marks it as not-yet-written.

| # | Invariant | Priority | Spec |
|---|---|---|---|
| [I1](./i1-message-identity.md) | Message identity is unique across layers | **P0** | `no-duplicate-messages.spec.ts` |
| [I2](./i2-no-lost-messages.md) | No lost messages under fault | **P0** | `no-lost-messages.spec.ts` |
| [I3](./i3-archive-live-boundary.md) | Archive/live boundary is consistent | **P0** | `archive-live-boundary.spec.ts` |
| [I4](./i4-restore-equivalence.md) | Restore-equivalence across devices | **P1** | `restore-equivalence.spec.ts` |
| [I5](./i5-send-outcomes.md) | Send outcomes are unambiguous | **P1** | `send-outcomes.spec.ts` |
| [I6](./i6-bad-credential-corrupt-backup.md) | Bad credential / corrupt backup fails legibly | **P1** | `bad-backup-secret.spec.ts` |
| [I7](./i7-deletion-races.md) | Account deletion races terminate cleanly | **P2** | `account-deletion-races.spec.ts` |
| [I8](./i8-sync-idempotent.md) | Sync is idempotent | **P2** | `sync-idempotent.spec.ts` |
| [I9](./i9-chain-walker.md) | Chain walker recovers history across N rotations | **P1** | `credential-rotation-continuity.spec.ts` |
| [I10](./i10-key-backup-object-name-safe.md) | Key backups survive any session_id, and never fail silently | **P1** | `key-backup-object-name.spec.ts` |
| [I11](./i11-no-cross-account-local-leak.md) | A new session never inherits a prior account's local state | **P1** | `no-cross-account-leak.spec.ts` |
| [I12](./i12-concurrent-sync.md) | Concurrent same-account clients converge | **P0** | `concurrent-sync.spec.ts` |
| [I13](./i13-media-quota.md) | Media quota is enforced, legible, and freed by delete | **P1** | `media-quota.spec.ts` |
| [I14](./i14-read-marker-convergence.md) | Read markers converge and never resurrect "New" | **P1** | *(not yet written)* |
| [I15](./i15-decryptability-closure.md) | Every envelope has a reachable key (backup-queue drain) | **P1** | *(not yet written)* |
| [I16](./i16-rotation-idempotent-replay.md) | Rotation resolves exactly once under ambiguous failure | **P1** | *(not yet written)* |
| [I17](./i17-amendment-authorization.md) | Amendments apply only from their author | **P1** | *(not yet written)* |
| [I18](./i18-cleanup-sweep-safety.md) | The cleanup sweep deletes only what policy names | **P2** | *(not yet written)* |

## Adding a new invariant

1. Add a row to the prioritisation table above.
2. Create `docs/scenarios/invariants/i{N}-<short-name>.md` using the template
   (Statement, Fault construction, Assertions, Permitted divergence; note the
   spec status at the top).
3. Add `web/e2e/invariants/<short-name>.spec.ts` that constructs the fault
   and asserts at the named layers.
4. If the invariant introduces a new helper or fault-injection mechanism,
   document it in `web/e2e/invariants/helpers.ts`.
