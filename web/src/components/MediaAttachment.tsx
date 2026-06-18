import { File as FileIcon } from 'lucide-react';
import type { MediaState } from '@/hooks/useMedia';
import { isLikelyImage, sanitizeDownloadFilename } from '@/lib/media';

interface Props {
    // State of the in-chat display object: the preview if one exists, else the
    // full. Absent until seeded: images are seeded 'idle' by useMedia;
    // non-images stay undefined until click-to-fetch.
    state?: MediaState;
    // State of the full image, populated only after a tap (ADR-0022 §3). When
    // ready it swaps in over the preview. Equal to `state` when there is no
    // preview (the full is its own display object).
    fullState?: MediaState;
    // Whether a separate full object exists to fetch on tap.
    hasPreview?: boolean;
    name: string;
    size: number;
    // Stored-image dimensions (ADR-0022). When both are present the box is sized
    // by aspect ratio so the image lands at its final footprint with no
    // load-time reflow. Absent on legacy/non-image attachments → fixed box.
    width?: number;
    height?: number;
    // Force-load the display object now — the non-image chip's click and the
    // network-error retry both call it.
    onRequest: () => void;
    // Load the full image (tap on a preview). No-op target when there's no
    // preview (the display already is the full).
    onRequestFull?: () => void;
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
    fullState,
    hasPreview = false,
    name,
    size,
    width,
    height,
    onRequest,
    onRequestFull,
    observe,
}: Props) {
    const displayName = sanitizeDownloadFilename(name);

    // Once the full is ready, render it over the preview; until then (or when
    // there's no preview) render the display state.
    const showFull = fullState?.status === 'ready' && !!fullState.blobUrl;
    const active = showFull ? fullState : state;
    const status = active?.status;
    const blobUrl = active?.blobUrl ?? null;
    const mime = active?.mime ?? null;
    const likelyImage = isLikelyImage(name);
    const unrequested = status === undefined || status === 'idle';
    // The displayed image is a tappable preview while the full hasn't loaded.
    const previewTappable =
        hasPreview && !showFull && status === 'ready' && !!blobUrl && !!mime;

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
    const imgStyle = hasDims
        ? ({ ...boxStyle, objectFit: 'contain' } as const)
        : ({ maxWidth: '100%', maxHeight: 400, objectFit: 'contain' } as const);

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
            {status === 'ready' &&
                blobUrl &&
                mime &&
                (previewTappable ? (
                    // Preview shown; tap fetches the full and swaps it in. The
                    // box is sized by the full's dimensions, so the swap is a
                    // crispness change with no layout shift.
                    <button
                        type="button"
                        data-testid="media-preview-button"
                        onClick={onRequestFull}
                        className="relative block max-w-full cursor-pointer"
                        style={boxStyle}
                    >
                        <img
                            data-testid="media-image"
                            src={blobUrl}
                            alt={displayName}
                            style={imgStyle}
                        />
                        {fullState?.status === 'loading' && (
                            <span className="absolute inset-0 flex items-center justify-center bg-background/40 text-xs">
                                Loading…
                            </span>
                        )}
                        {fullState?.status === 'network-error' && (
                            <span className="absolute inset-0 flex items-center justify-center bg-background/40 text-xs">
                                Failed — tap to retry
                            </span>
                        )}
                    </button>
                ) : (
                    <a href={blobUrl} target="_blank" rel="noopener noreferrer">
                        <img
                            data-testid="media-image"
                            src={blobUrl}
                            alt={displayName}
                            style={imgStyle}
                        />
                    </a>
                ))}
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
