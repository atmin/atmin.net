# Centralize IndexedDB transaction wrapper

## Spec
None — internal hygiene. The data layout and migration sequence in `web/src/lib/db.ts` is the contract; do not change it. The `DB_VERSION` (currently 5) and the `onupgradeneeded` migration ladder must remain byte-identical.

## Current
`web/src/lib/db.ts` is 662 lines, made up almost entirely of hand-rolled IndexedDB request → Promise wrappers. Every read/write helper repeats a variant of:

```ts
return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();   // for writes
    tx.onerror = () => reject(tx.error);
});
// or
return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
});
```

There are 14 of these. Some have subtle bugs waiting to happen — e.g. `clearKeyShares` opens a cursor and resolves on `tx.oncomplete`, which is correct, but a future helper that forgets `tx.onerror` would silently hang.

`saveMessages` (lines ~234–314) has a particularly subtle pattern: the conversation summary upsert issues `getReq.onsuccess` callbacks **inside** the transaction, queueing the subsequent `convStore.put` on the same tx. This works because IDB autocommits when the microtask queue drains, but is fragile.

## Change
Add a small private helper at the top of `db.ts`:

```ts
function awaitTx(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror   = () => reject(tx.error);
        tx.onabort   = () => reject(tx.error ?? new Error('tx aborted'));
    });
}

function awaitReq<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}
```

Replace every hand-rolled `new Promise(...)` in the file with one of these two helpers. Functions become 3-line bodies, e.g.:

```ts
export async function putKey(name: string, key: CryptoKey): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(KEYS_STORE, 'readwrite');
    tx.objectStore(KEYS_STORE).put(key, name);
    return awaitTx(tx);
}
```

For `saveMessages`, document the autocommit pattern with a short comment, but leave the read-modify-write structure intact (changing it is a separate concern). Add the missing `tx.onerror` handler if any helper currently lacks one (`clearMessages` cursor variant, `clearKeyShares` cursor variant).

Do **not** introduce a new dependency (`idb` package). The helpers above are 15 lines and zero-dep — that's a better fit for this codebase than adopting another runtime.

## Verify
- `make web-test` passes. Existing `web/src/lib/db.test.ts` is the regression net (it has 485 lines of coverage).
- `grep -c "new Promise" web/src/lib/db.ts` ≤ 1 (only the IDB open promise, which is special — `onupgradeneeded` is event-driven and shouldn't go through `awaitReq`).
- File line count drops meaningfully (target: under 500 lines).
- No behavioural regressions: deleted/added IDB stores remain identical, primary keys and indexes unchanged.
