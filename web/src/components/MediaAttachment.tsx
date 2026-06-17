import { File as FileIcon } from 'lucide-react';
import type { MediaState } from '@/hooks/useMedia';
import { isLikelyImage, sanitizeDownloadFilename } from '@/lib/media';

interface Props {
    // Absent until seeded: images are seeded 'idle' by useMedia; non-images are
    // never tracked, so their state stays undefined until click-to-fetch.
    state?: MediaState;
    name: string;
    size: number;
    // Stored-image dimensions (ADR-0022). When both are present the box is sized
    // by aspect ratio so the image lands at its final footprint with no
    // load-time reflow. Absent on legacy/non-image attachments → fixed box.
    width?: number;
    height?: number;
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
    width,
    height,
    onRequest,
    observe,
}: Props) {
    const displayName = sanitizeDownloadFilename(name);
    const status = state?.status;
    const blobUrl = state?.blobUrl ?? null;
    const mime = state?.mime ?? null;
    const likelyImage = isLikelyImage(name);
    const unrequested = status === undefined || status === 'idle';

    // Reserve the exact footprint the image will fill (capped like the loaded
    // <img> below): the placeholder, the loading box, and the image all share
    // these constraints, so swapping between them causes no layout shift.
    const hasDims =
        typeof width === 'number' &&
        typeof height === 'number' &&
        width > 0 &&
        height > 0;
    const boxStyle = hasDims
        ? {
              aspectRatio: `${width} / ${height}`,
              width,
              maxWidth: '100%',
              maxHeight: 400,
          }
        : undefined;

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
                    hasDims ? (
                        <div
                            data-testid="media-placeholder"
                            className="rounded-lg bg-muted"
                            style={boxStyle}
                        />
                    ) : (
                        <div
                            data-testid="media-placeholder"
                            // Fixed modest box when dimensions are unknown
                            // (legacy v0.1 messages without width/height).
                            className="h-40 w-60 max-w-full rounded-lg bg-muted"
                        />
                    )
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
            {status === 'loading' &&
                (hasDims ? (
                    // Hold the reserved box (animated) so idle→loading→ready
                    // never reflows.
                    <div
                        data-testid="media-placeholder"
                        className="animate-pulse rounded-lg bg-muted"
                        style={boxStyle}
                    />
                ) : (
                    <span className="text-xs opacity-70">Loading…</span>
                ))}
            {status === 'ready' && blobUrl && mime && (
                <a href={blobUrl} target="_blank" rel="noopener noreferrer">
                    <img
                        data-testid="media-image"
                        src={blobUrl}
                        alt={displayName}
                        style={
                            hasDims
                                ? { ...boxStyle, objectFit: 'contain' }
                                : {
                                      maxWidth: '100%',
                                      maxHeight: 400,
                                      objectFit: 'contain',
                                  }
                        }
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
