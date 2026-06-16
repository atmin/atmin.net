import { File as FileIcon } from 'lucide-react';
import type { MediaState } from '@/hooks/useMedia';
import { isLikelyImage, sanitizeDownloadFilename } from '@/lib/media';

interface Props {
    // Absent until seeded: images are seeded 'idle' by useMedia; non-images are
    // never tracked, so their state stays undefined until click-to-fetch.
    state?: MediaState;
    name: string;
    size: number;
    // Force-load this attachment now — the non-image chip's click and the
    // network-error retry both call it.
    onRequest: () => void;
    // Ref callback (already curried to this url) — attached only for images, so
    // they lazy-load on scroll. Ref callbacks are allowed in components/.
    observe?: (el: HTMLElement | null) => void;
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MediaAttachment({
    state,
    name,
    size,
    onRequest,
    observe,
}: Props) {
    const displayName = sanitizeDownloadFilename(name);
    const status = state?.status;
    const blobUrl = state?.blobUrl ?? null;
    const mime = state?.mime ?? null;
    const likelyImage = isLikelyImage(name);
    const unrequested = status === undefined || status === 'idle';

    return (
        <div
            data-testid="media-attachment"
            data-status={status ?? 'idle'}
            // Observe only images; non-images are never auto-fetched.
            ref={likelyImage ? observe : undefined}
        >
            {/* Not yet requested: image → observable placeholder; non-image →
                metadata-only chip (zero bytes), fetch on click. */}
            {unrequested &&
                (likelyImage ? (
                    <div
                        data-testid="media-placeholder"
                        // Fixed modest box until the preview task supplies real
                        // dimensions for zero-layout-shift sizing.
                        className="h-40 w-60 max-w-full rounded-lg bg-muted"
                    />
                ) : (
                    <button
                        type="button"
                        data-testid="media-chip"
                        onClick={onRequest}
                        className="flex max-w-full items-center gap-2 rounded-lg border border-input px-3 py-2 text-left hover:bg-accent"
                    >
                        <FileIcon
                            className="size-4 shrink-0 opacity-70"
                            aria-hidden
                        />
                        <span className="min-w-0">
                            <span className="block truncate text-sm">
                                {displayName}
                            </span>
                            <span className="block text-xs opacity-70">
                                {formatBytes(size)}
                            </span>
                        </span>
                    </button>
                ))}
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
                    onClick={onRequest}
                    className="text-xs underline"
                >
                    Failed to load — retry
                </button>
            )}
        </div>
    );
}
