import { useEffect, useRef, useState } from 'react';
import {
    NotFoundError,
    fetchMedia,
} from '@/lib/api';
import {
    MediaCorruptError,
    decryptMedia,
    sanitizeDownloadFilename,
    sniffInlineImageMime,
} from '@/lib/media';

export interface MediaFile {
    url: string;
    key: Uint8Array;
    iv: Uint8Array;
    name: string;
    size: number;
}

type Status =
    | 'loading'
    | 'ready'
    | 'corrupt'
    | 'unavailable'
    | 'network-error';

interface Props {
    file: MediaFile;
    token: string;
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MediaAttachment({ file, token }: Props) {
    const [status, setStatus] = useState<Status>('loading');
    const [blobUrl, setBlobUrl] = useState<string | null>(null);
    const [mime, setMime] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const urlRef = useRef<string | null>(null);

    useEffect(() => {
        const ctl = new AbortController();
        let cancelled = false;
        setStatus('loading');

        (async () => {
            try {
                const ciphertext = await fetchMedia(token, file.url, ctl.signal);
                if (cancelled) return;
                const plaintext = await decryptMedia(
                    ciphertext,
                    file.key,
                    file.iv,
                );
                if (cancelled) return;
                const detected = sniffInlineImageMime(plaintext);
                const blob = new Blob(
                    [plaintext as unknown as BlobPart],
                    detected
                        ? { type: detected }
                        : { type: 'application/octet-stream' },
                );
                const url = URL.createObjectURL(blob);
                urlRef.current = url;
                setBlobUrl(url);
                setMime(detected);
                setStatus('ready');
            } catch (e) {
                if (cancelled) return;
                if (e instanceof MediaCorruptError) setStatus('corrupt');
                else if (e instanceof NotFoundError) setStatus('unavailable');
                else setStatus('network-error');
            }
        })();

        return () => {
            cancelled = true;
            ctl.abort();
            if (urlRef.current) {
                URL.revokeObjectURL(urlRef.current);
                urlRef.current = null;
            }
        };
        // key/iv are deterministically bound to file.url (same envelope),
        // but toMessages allocates fresh Uint8Arrays on every refetch. Keep
        // them out of deps so we don't refetch the same blob on each sync.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [file.url, token, attempt]);

    const displayName = sanitizeDownloadFilename(file.name);

    return (
        <div data-testid="media-attachment" data-status={status}>
            {status === 'loading' && (
                <span className="text-xs opacity-70">Loading…</span>
            )}
            {status === 'ready' && blobUrl && mime && (
                <a
                    href={blobUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    <img
                        data-testid="media-image"
                        src={blobUrl}
                        alt={displayName}
                        style={{
                            maxWidth: '100%',
                            maxHeight: 400,
                            objectFit: 'contain',
                        }}
                    />
                </a>
            )}
            {status === 'ready' && blobUrl && !mime && (
                <a
                    data-testid="media-download"
                    href={blobUrl}
                    download={displayName}
                    rel="noopener noreferrer"
                    className="underline"
                >
                    {displayName} · {formatBytes(file.size)}
                </a>
            )}
            {status === 'corrupt' && (
                <span className="text-xs text-destructive">
                    Attachment is corrupt
                </span>
            )}
            {status === 'unavailable' && (
                <span className="text-xs opacity-70">
                    Attachment no longer available
                </span>
            )}
            {status === 'network-error' && (
                <button
                    type="button"
                    onClick={() => setAttempt((a) => a + 1)}
                    className="text-xs underline"
                >
                    Failed to load — retry
                </button>
            )}
        </div>
    );
}
