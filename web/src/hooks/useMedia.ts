import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMedia, NotFoundError } from '@/lib/api';
import {
    deleteMediaBlob,
    getMediaBlob,
    putMediaBlob,
    type StoredMediaBlob,
} from '@/lib/db';
import { imageSize, makePreview, needsPreview } from '@/lib/image';
import {
    decryptMedia,
    type InlineMime,
    isLikelyImage,
    MediaCorruptError,
    type MediaFile,
    sniffInlineImageMime,
} from '@/lib/media';

export type MediaStatus =
    | 'idle'
    | 'loading'
    | 'ready'
    | 'corrupt'
    | 'unavailable'
    | 'network-error';

export interface MediaState {
    status: MediaStatus;
    blobUrl: string | null;
    mime: InlineMime | null;
}

export interface MediaLoader {
    states: Record<string, MediaState>;
    // Attach to an image's element via a ref callback: `ref={(el) =>
    // observe(url, el)}`. Idempotent and churn-proof (see below). Loads the
    // file once when it nears the viewport, then stops observing (one-shot).
    observe: (url: string, el: HTMLElement | null) => void;
    // Force-load a url now — the manual `network-error` retry and the
    // non-image chip's click-to-fetch both route here.
    request: (url: string) => void;
}

const IDLE: MediaState = { status: 'idle', blobUrl: null, mime: null };
const LOADING: MediaState = { status: 'loading', blobUrl: null, mime: null };

// How a fetched object is persisted for offline browsing (ADR-0022 §7):
//   'preview' — a preview object → cache the decrypted bytes verbatim (tiny);
//   'derive'  — a preview-less image's in-chat display object → cache a small
//               one verbatim, downscale a larger one to a local thumbnail (a
//               full original is never persisted — that is deferred v2);
//   'none'    — the on-tap full of a previewed image (a full original) → not
//               cached.
type CachePolicy = 'preview' | 'derive' | 'none';

// The unit of fetching: any encrypted object, keyed by its own url. Each media
// file contributes its full object and, when present, its preview object — both
// independently keyed (ADR-0022), so the in-chat preview and the on-tap full
// load and cache separately.
interface Loadable {
    url: string;
    key: Uint8Array;
    iv: Uint8Array;
    cache: CachePolicy;
}

function loadables(files: MediaFile[]): Loadable[] {
    const out: Loadable[] = [];
    for (const f of files) {
        // A previewed image's full is the on-tap original (not cached); a
        // preview-less image's full IS its in-chat display object (cached).
        out.push({
            url: f.url,
            key: f.key,
            iv: f.iv,
            cache: f.preview ? 'none' : 'derive',
        });
        if (f.preview)
            out.push({
                url: f.preview.url,
                key: f.preview.key,
                iv: f.preview.iv,
                cache: 'preview',
            });
    }
    return out;
}

// What renders in-chat: the preview if there is one (the full is fetched on a
// tap), else the full is its own display object.
const displayUrl = (f: MediaFile): string => f.preview?.url ?? f.url;

const toPart = (u: Uint8Array): BlobPart => u as unknown as BlobPart;

// Copy out an exact ArrayBuffer (a decrypted view may be a subarray of a larger
// buffer) for the durable record.
function toEntry(
    url: string,
    bytes: Uint8Array,
    mime: InlineMime | null,
): StoredMediaBlob {
    return {
        url,
        bytes: bytes.slice().buffer as ArrayBuffer,
        mime: mime ?? 'application/octet-stream',
        cachedAt: Date.now(),
    };
}

// Best-effort write-through of a decrypted object to the offline cache. Never
// throws — any decode / canvas / IDB failure simply leaves no entry and a later
// view re-fetches. A full original is never persisted (ADR-0022 §7 — deferred
// v2): preview-less images are cached small-verbatim or downscaled-to-thumbnail.
async function cacheAfterLoad(
    file: Loadable,
    plaintext: Uint8Array,
): Promise<void> {
    try {
        if (file.cache === 'none') return;
        const mime = sniffInlineImageMime(plaintext);
        if (file.cache === 'preview') {
            await putMediaBlob(toEntry(file.url, plaintext, mime));
            return;
        }
        // 'derive': a preview-less image's display object. A non-image is a full
        // original → never cached.
        if (!mime) return;
        const blob = new Blob([toPart(plaintext)], { type: mime });
        const { width, height } = await imageSize(blob);
        if (!needsPreview(plaintext.byteLength, width, height)) {
            // Below threshold: the full IS a fine preview — cache it verbatim.
            await putMediaBlob(toEntry(file.url, plaintext, mime));
            return;
        }
        // Larger: downscale to a local ~512px thumbnail and cache that, so the
        // full original is not persisted yet later browsing stays offline.
        const thumb = await makePreview(blob);
        const bytes = new Uint8Array(await thumb.blob.arrayBuffer());
        await putMediaBlob(toEntry(file.url, bytes, 'image/jpeg'));
    } catch {
        // Best-effort — leave the cache untouched on any failure.
    }
}

// Ask the browser to keep our storage under pressure (ADR-0022 §7). One-shot
// across the whole app; never depended on — a miss simply re-fetches.
let persistenceRequested = false;
function requestStoragePersistence(): void {
    if (persistenceRequested) return;
    persistenceRequested = true;
    try {
        void navigator.storage?.persist?.();
    } catch {
        // no-op — persistence is an optimization, never required.
    }
}

export function useMedia(
    files: MediaFile[],
    token: string | undefined,
): MediaLoader {
    const [states, setStates] = useState<Record<string, MediaState>>({});
    const controllersRef = useRef<Map<string, AbortController>>(new Map());
    const blobsRef = useRef<Map<string, string>>(new Map());
    const filesRef = useRef<Map<string, Loadable>>(new Map());
    const tokenRef = useRef<string | undefined>(token);

    // Lazy-load wiring. The observer is created on first observe() so the
    // jsdom/SSR fallback (no IntersectionObserver) never constructs one.
    const observerRef = useRef<IntersectionObserver | null>(null);
    const observedRef = useRef<Map<Element, string>>(new Map()); // element → url
    const elByUrlRef = useRef<Map<string, Element>>(new Map()); // url → element
    const triggeredRef = useRef<Set<string>>(new Set()); // url → load fired (one-shot)
    const trackedRef = useRef<Set<string>>(new Set()); // urls that have a state entry

    // Keep refs fresh so retry()/request()/intersection always see the current
    // file metadata/token. key/iv are fresh Uint8Arrays on every sync, so we
    // key by url only.
    filesRef.current = new Map(loadables(files).map((l) => [l.url, l]));
    tokenRef.current = token;

    const load = useCallback((file: Loadable, tok: string) => {
        trackedRef.current.add(file.url);
        controllersRef.current.get(file.url)?.abort();
        const ctl = new AbortController();
        controllersRef.current.set(file.url, ctl);
        setStates((s) => ({ ...s, [file.url]: LOADING }));

        // Build the object URL + ready state from decrypted bytes — shared by
        // the cache-hit and the fetch paths.
        const present = (plaintext: Uint8Array) => {
            const detected = sniffInlineImageMime(plaintext);
            const blob = new Blob(
                [toPart(plaintext)],
                detected
                    ? { type: detected }
                    : { type: 'application/octet-stream' },
            );
            const url = URL.createObjectURL(blob);
            const prev = blobsRef.current.get(file.url);
            if (prev) URL.revokeObjectURL(prev);
            blobsRef.current.set(file.url, url);
            setStates((s) => ({
                ...s,
                [file.url]: { status: 'ready', blobUrl: url, mime: detected },
            }));
        };

        (async () => {
            try {
                // Read-through: a cache hit renders with no network. Media
                // objects are write-once, so a cached entry is never stale.
                const cached = await getMediaBlob(file.url).catch(
                    () => undefined,
                );
                if (ctl.signal.aborted) return;
                if (cached) {
                    present(new Uint8Array(cached.bytes));
                    return;
                }
                const ciphertext = await fetchMedia(tok, file.url, ctl.signal);
                if (ctl.signal.aborted) return;
                const plaintext = await decryptMedia(
                    ciphertext,
                    file.key,
                    file.iv,
                );
                if (ctl.signal.aborted) return;
                present(plaintext);
                // Durable cache write is best-effort and off the render path.
                void cacheAfterLoad(file, plaintext);
            } catch (e) {
                if (ctl.signal.aborted) return;
                let status: MediaStatus = 'network-error';
                if (e instanceof MediaCorruptError) status = 'corrupt';
                else if (e instanceof NotFoundError) {
                    status = 'unavailable';
                    // Retention swept the original (ADR-0006) → evict any cache
                    // entry so it doesn't linger after the source is gone.
                    void deleteMediaBlob(file.url).catch(() => {});
                }
                setStates((s) => ({
                    ...s,
                    [file.url]: { status, blobUrl: null, mime: null },
                }));
            }
        })();
    }, []);

    // Attach to an image's element. React calls a `ref={(el) => observe(url,
    // el)}` callback with null then the element on EVERY render (and `files`
    // gets fresh identity each sync), so this must be idempotent and churn-proof:
    //   - ignore el === null (the detach half) so we don't unobserve a one-shot
    //     we're about to re-arm;
    //   - no-op if the url is already triggered (loaded forever this session) or
    //     already observed on the same element;
    //   - otherwise observe and record it.
    const observe = useCallback(
        (url: string, el: HTMLElement | null) => {
            if (el === null) return;
            if (triggeredRef.current.has(url)) return;
            if (elByUrlRef.current.get(url) === el) return;

            let obs = observerRef.current;
            if (!obs) {
                if (typeof IntersectionObserver === 'undefined') return;
                obs = new IntersectionObserver(
                    (entries) => {
                        for (const entry of entries) {
                            if (!entry.isIntersecting) continue;
                            const u = observedRef.current.get(entry.target);
                            if (u === undefined) continue;
                            // One-shot: stop watching this element.
                            observerRef.current?.unobserve(entry.target);
                            observedRef.current.delete(entry.target);
                            elByUrlRef.current.delete(u);
                            if (triggeredRef.current.has(u)) continue;
                            const f = filesRef.current.get(u);
                            const tok = tokenRef.current;
                            if (!f || !tok) continue;
                            triggeredRef.current.add(u);
                            load(f, tok);
                        }
                    },
                    // Prefetch just before entering view. root:null = the
                    // viewport, which the chat scroller fills.
                    { rootMargin: '200px' },
                );
                observerRef.current = obs;
            }

            // The url moved to a different element (re-mount): drop the old one.
            const prevEl = elByUrlRef.current.get(url);
            if (prevEl && prevEl !== el) {
                obs.unobserve(prevEl);
                observedRef.current.delete(prevEl);
            }
            elByUrlRef.current.set(url, el);
            observedRef.current.set(el, url);
            obs.observe(el);
        },
        [load],
    );

    useEffect(() => {
        if (!token) return;
        // Every loadable url (full + preview) is a cleanup candidate.
        const current = new Set(filesRef.current.keys());
        // No IntersectionObserver (jsdom/SSR): preserve today's eager load so
        // tests and non-browser render paths work without mocking the observer.
        const fallback = typeof IntersectionObserver === 'undefined';

        for (const f of files) {
            // Only images are observed/seeded. Non-images render a click-to-
            // fetch chip (§MediaAttachment) and are never auto-downloaded.
            if (!isLikelyImage(f.name)) continue;
            // Lazy-load the display object (preview if present, else full); the
            // full of a previewed image loads only on an explicit tap.
            const url = displayUrl(f);
            const loadable = filesRef.current.get(url);
            if (!loadable) continue;
            if (fallback) {
                if (!controllersRef.current.has(url)) load(loadable, token);
                continue;
            }
            // Seed 'idle' so the placeholder mounts and becomes observable.
            // Loading waits for intersection — do NOT call load here.
            trackedRef.current.add(url);
            setStates((s) => (url in s ? s : { ...s, [url]: IDLE }));
        }

        // Teardown for files that left the message list entirely (e.g. a
        // deleted message). Scrolling away never lands here — only urls that
        // are no longer in `files` are released.
        for (const url of Array.from(trackedRef.current)) {
            if (current.has(url)) continue;
            controllersRef.current.get(url)?.abort();
            controllersRef.current.delete(url);
            const blob = blobsRef.current.get(url);
            if (blob) URL.revokeObjectURL(blob);
            blobsRef.current.delete(url);
            triggeredRef.current.delete(url);
            trackedRef.current.delete(url);
            const el = elByUrlRef.current.get(url);
            if (el) {
                observerRef.current?.unobserve(el);
                observedRef.current.delete(el);
                elByUrlRef.current.delete(url);
            }
            setStates((s) => {
                if (!(url in s)) return s;
                const n = { ...s };
                delete n[url];
                return n;
            });
        }
    }, [files, token, load]);

    useEffect(() => {
        // One-shot, best-effort: reduce eviction of the offline media cache.
        requestStoragePersistence();
        const controllers = controllersRef.current;
        const blobs = blobsRef.current;
        const observed = observedRef.current;
        const elByUrl = elByUrlRef.current;
        const triggered = triggeredRef.current;
        const tracked = trackedRef.current;
        return () => {
            observerRef.current?.disconnect();
            observerRef.current = null;
            for (const ctl of controllers.values()) ctl.abort();
            for (const url of blobs.values()) URL.revokeObjectURL(url);
            controllers.clear();
            blobs.clear();
            observed.clear();
            elByUrl.clear();
            triggered.clear();
            tracked.clear();
        };
    }, []);

    const request = useCallback(
        (url: string) => {
            const f = filesRef.current.get(url);
            const tok = tokenRef.current;
            if (f && tok) load(f, tok);
        },
        [load],
    );

    return { states, observe, request };
}
