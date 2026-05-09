# Document or refactor the saveMessages IndexedDB transaction pattern

## Spec
None — internal correctness. The contract `saveMessages` must satisfy: each call atomically persists the messages and updates the conversation summaries (last message text, last timestamp, message count).

## Current
`web/src/lib/db.ts` `saveMessages` (lines ~234–314) opens a single `readwrite` transaction over both `messages` and `conversations` stores, then for each conversation:

```ts
const getReq = convStore.get(convId);
getReq.onsuccess = () => {
    const existing = getReq.result as StoredConversation | undefined;
    const conv: StoredConversation = { ... };
    convStore.put(conv);
};
```

This relies on a subtle IDB property: as long as a request is issued from the `onsuccess` callback of another request **on the same transaction**, the transaction stays alive (it autocommits only when the request queue is empty AND no further requests have been queued in microtasks). Works correctly today, but:

- A future contributor adding `await something()` inside that `onsuccess` would inadvertently break the transaction (the `await` yields to the macrotask queue; the tx commits before `convStore.put` is queued).
- The pattern doesn't surface errors from `getReq.onerror` — they fall through to the (handled) `tx.onerror`, which is correct, but accidentally so.

## Change
Two options; pick one based on appetite:

### 14a. Documentation-only (recommended for a low-effort fix)
Add a focused comment block above the conversation-update loop in `saveMessages`:

```ts
// IDB autocommit: this read-modify-write upsert relies on issuing convStore.put
// synchronously from getReq.onsuccess, which keeps the transaction alive.
// Do not introduce `await` between getReq and convStore.put — the transaction
// will commit at the next microtask boundary and the put will throw
// TransactionInactiveError. If you need async work between read and write,
// gather the existing rows into a Map first, await whatever you need, then
// open a new readwrite transaction for the writes.
```

Add the missing `getReq.onerror = () => { /* propagates via tx.onerror */ };` if a strict-no-uncaught-IDB-events lint rule ever lands; not strictly required today.

### 14b. Refactor to two-phase
Read all existing conversation summaries first, then open a fresh `readwrite` transaction for all writes:

```ts
const tx1 = db.transaction(CONVERSATIONS_STORE, 'readonly');
const existingByID = new Map<string, StoredConversation>();
for (const convId of convUpdates.keys()) {
    const existing = await awaitReq(tx1.objectStore(CONVERSATIONS_STORE).get(convId));
    if (existing) existingByID.set(convId, existing);
}
await awaitTx(tx1);

const tx2 = db.transaction([MESSAGES_STORE, CONVERSATIONS_STORE], 'readwrite');
// ... synchronous puts using existingByID lookups ...
await awaitTx(tx2);
```

Loses true atomicity (a crash between tx1 and tx2 is observable), but gains readability. Atomicity here is not load-bearing — the messages are append-only and idempotent by `id`; the worst outcome of a partial commit is a stale conversation summary that is corrected on next sync.

(If task 09 has landed first, `awaitReq` / `awaitTx` are already available.)

## Verify
- `make web-test` passes; existing `web/src/lib/db.test.ts` covers the contract.
- Manual test: send 3 messages in quick succession, refresh the page, observe the chats list shows the latest message text and the correct count.
- If you went with 14b: the new two-phase code has its own test or extends an existing one to assert that `existingByID` lookup doesn't lose count when the same conversation is updated twice in the same call (the existing test at `db.test.ts` likely already covers this — verify before writing a new one).
