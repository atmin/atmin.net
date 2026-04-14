import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMedia, NotFoundError } from '@/lib/api';
import {
    decryptMedia,
    type InlineMime,
    MediaCorruptError,
    type MediaFile,
    sniffInlineImageMime,
} from '@/lib/media';

export type MediaStatus =
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
    retry: (url: string) => void;
}

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

    // Keep refs fresh so retry() always sees the current file metadata/token.
    // key/iv are fresh Uint8Arrays on every sync, so we key by url only.
    filesRef.current = new Map(files.map((f) => [f.url, f]));
    tokenRef.current = token;

    const load = useCallback((file: MediaFile, tok: string) => {
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

    useEffect(() => {
        if (!token) return;
        const current = new Set(files.map((f) => f.url));

        for (const f of files) {
            if (!controllersRef.current.has(f.url)) load(f, token);
        }
        for (const url of Array.from(controllersRef.current.keys())) {
            if (current.has(url)) continue;
            controllersRef.current.get(url)?.abort();
            controllersRef.current.delete(url);
            const blob = blobsRef.current.get(url);
            if (blob) URL.revokeObjectURL(blob);
            blobsRef.current.delete(url);
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
        return () => {
            for (const ctl of controllers.values()) ctl.abort();
            for (const url of blobs.values()) URL.revokeObjectURL(url);
            controllers.clear();
            blobs.clear();
        };
    }, []);

    const retry = useCallback(
        (url: string) => {
            const f = filesRef.current.get(url);
            const tok = tokenRef.current;
            if (f && tok) load(f, tok);
        },
        [load],
    );

    return { states, retry };
}
