import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMedia, NotFoundError } from '@/lib/api';
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

export function useMedia(
    files: MediaFile[],
    token: string | undefined,
): MediaLoader {
    const [states, setStates] = useState<Record<string, MediaState>>({});
    const controllersRef = useRef<Map<string, AbortController>>(new Map());
    const blobsRef = useRef<Map<string, string>>(new Map());
    const filesRef = useRef<Map<string, MediaFile>>(new Map());
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
    filesRef.current = new Map(files.map((f) => [f.url, f]));
    tokenRef.current = token;

    const load = useCallback((file: MediaFile, tok: string) => {
        trackedRef.current.add(file.url);
        controllersRef.current.get(file.url)?.abort();
        const ctl = new AbortController();
        controllersRef.current.set(file.url, ctl);
        setStates((s) => ({ ...s, [file.url]: LOADING }));

        (async () => {
            try {
                const ciphertext = await fetchMedia(tok, file.url, ctl.signal);
                if (ctl.signal.aborted) return;
                const plaintext = await decryptMedia(
                    ciphertext,
                    file.key,
                    file.iv,
                );
                if (ctl.signal.aborted) return;
                const detected = sniffInlineImageMime(plaintext);
                const blob = new Blob(
                    [plaintext as unknown as BlobPart],
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
                    [file.url]: {
                        status: 'ready',
                        blobUrl: url,
                        mime: detected,
                    },
                }));
            } catch (e) {
                if (ctl.signal.aborted) return;
                let status: MediaStatus = 'network-error';
                if (e instanceof MediaCorruptError) status = 'corrupt';
                else if (e instanceof NotFoundError) status = 'unavailable';
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
        const current = new Set(files.map((f) => f.url));
        // No IntersectionObserver (jsdom/SSR): preserve today's eager load so
        // tests and non-browser render paths work without mocking the observer.
        const fallback = typeof IntersectionObserver === 'undefined';

        for (const f of files) {
            // Only images are observed/seeded. Non-images render a click-to-
            // fetch chip (§MediaAttachment) and are never auto-downloaded.
            if (!isLikelyImage(f.name)) continue;
            if (fallback) {
                if (!controllersRef.current.has(f.url)) load(f, token);
                continue;
            }
            // Seed 'idle' so the placeholder mounts and becomes observable.
            // Loading waits for intersection — do NOT call load here.
            trackedRef.current.add(f.url);
            setStates((s) => (f.url in s ? s : { ...s, [f.url]: IDLE }));
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
