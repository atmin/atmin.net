/**
 * A complete in-memory Web {@link Storage} for unit tests.
 *
 * Install it per test and restore after, never relying on the ambient global:
 *
 * ```ts
 * beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
 * afterEach(() => vi.unstubAllGlobals());
 * ```
 *
 * Why this exists: the unit project runs in node (DOM, when present, comes only
 * from a per-file `@vitest-environment` directive). A test file that
 * `defineProperty`s a *partial* `globalThis.localStorage` leaks it into sibling
 * files in a reused CI worker — green locally, red in CI, with errors like
 * "localStorage.clear is not a function" depending on file order. Owning a
 * fresh, full Storage per test (and unstubbing after) removes that coupling.
 */
export function memoryStorage(): Storage {
    const m = new Map<string, string>();
    return {
        get length() {
            return m.size;
        },
        clear: () => m.clear(),
        getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
        key: (i) => [...m.keys()][i] ?? null,
        removeItem: (k) => {
            m.delete(k);
        },
        setItem: (k, v) => {
            m.set(k, String(v));
        },
    };
}
