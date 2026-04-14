import type { MediaState } from '@/hooks/useMedia';
import { sanitizeDownloadFilename } from '@/lib/media';

interface Props {
    state: MediaState;
    name: string;
    size: number;
    onRetry: () => void;
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MediaAttachment({ state, name, size, onRetry }: Props) {
    const displayName = sanitizeDownloadFilename(name);
    const { status, blobUrl, mime } = state;

    return (
        <div data-testid="media-attachment" data-status={status}>
            {status === 'loading' && (
                <span className="text-xs opacity-70">Loading…</span>
            )}
            {status === 'ready' && blobUrl && mime && (
                <a href={blobUrl} target="_blank" rel="noopener noreferrer">
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
                    {displayName} · {formatBytes(size)}
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
                    onClick={onRetry}
                    className="text-xs underline"
                >
                    Failed to load — retry
                </button>
            )}
        </div>
    );
}
