import { Message } from 'konsta/react';
import { EllipsisVertical } from 'lucide-react';
import type { MediaState } from '@/hooks/useMedia';
import type { MediaFile } from '@/lib/media';
import MediaAttachment from './MediaAttachment';

interface Props {
    text: string;
    timestamp: Date;
    sent: boolean;
    media?: MediaFile;
    mediaState?: MediaState;
    // State of the full image, fetched on tap when a preview exists (ADR-0022).
    mediaFullState?: MediaState;
    // Force-load a url (non-image chip click + network-error retry, or tap-for-
    // full). The display vs full url is curried at this leaf.
    onMediaRequest?: (url: string) => void;
    // Lazy-load observe wiring for images; curried to the url at the leaf.
    mediaObserve?: (url: string, el: HTMLElement | null) => void;
    // Amendment state (set by the materializer).
    editedAt?: Date;
    deleted?: boolean;
    // Opens the per-bubble action sheet (edit/delete). Provided only for the
    // user's own, amendable messages — its presence also gates the ⋮ trigger.
    // Editing itself happens in the composer (ChatView), not here.
    onRequestActions?: () => void;
}

// Relative phrasing for the gap between a message and its edit ("3 weeks
// later"). Buckets are keyed off whole minutes so the tier and the label below
// stay consistent at every threshold.
function relativeEdit(mins: number): string {
    if (mins < 1) return 'moments later';
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} later`;
    if (mins < 1440) {
        const h = Math.round(mins / 60);
        return `${h} hour${h === 1 ? '' : 's'} later`;
    }
    const days = Math.round(mins / 1440);
    if (days < 7) return `${days} day${days === 1 ? '' : 's'} later`;
    if (days < 35) {
        const w = Math.round(days / 7);
        return `${w} week${w === 1 ? '' : 's'} later`;
    }
    if (days < 365) {
        const mo = Math.round(days / 30);
        return `${mo} month${mo === 1 ? '' : 's'} later`;
    }
    const y = Math.round(days / 365);
    return `${y} year${y === 1 ? '' : 's'} later`;
}

type EditedTier = 'quiet' | 'mid' | 'loud';

// The edit's visual treatment escalates with the delay (ADR-0014): a quick fix
// stays muted, while a late rewrite reads loud so silent gaslighting is visible
// at a glance rather than hidden in a tooltip.
//
// - quiet (< 1h): just "edited", muted — a benign typo fix.
// - mid (1h–24h): "edited N hours later", full-opacity foreground.
// - loud (≥ 24h): "edited N days/weeks later", amber + medium weight.
function editedInfo(
    timestamp: Date,
    editedAt: Date,
): { label: string; tier: EditedTier; title: string } {
    const iso = editedAt.toISOString();
    if (timestamp.getTime() === 0) {
        return { label: 'edited', tier: 'quiet', title: `Edited at ${iso}` };
    }
    const mins = Math.round(
        Math.max(0, editedAt.getTime() - timestamp.getTime()) / 60_000,
    );
    const rel = relativeEdit(mins);
    const title = `Edited ${rel} (${iso})`;
    if (mins < 60) return { label: 'edited', tier: 'quiet', title };
    if (mins < 1440) return { label: `edited ${rel}`, tier: 'mid', title };
    return { label: `edited ${rel}`, tier: 'loud', title };
}

const EDITED_TIER_CLASS: Record<EditedTier, string> = {
    quiet: 'opacity-50',
    mid: '',
    loud: 'font-medium text-amber-600 dark:text-amber-400',
};

// Konsta colours sent bubbles system-blue / received system-grey. A deleted
// message overrides that to a neutral surface so the placeholder reads as
// chrome, not content.
const NEUTRAL_BUBBLE = {
    messageSent: 'text-foreground',
    bubbleSentIos: 'bg-muted',
    bubbleSentMd: 'bg-muted',
    bubbleReceivedIos: 'bg-muted',
    bubbleReceivedMd: 'bg-muted',
};

// Bubble width cap — the single tune point. Konsta defaults k-message to
// max-w-[70%]; the trailing `!` makes this win regardless of CSS source order.
// Bump the percentage to give long content (e.g. wrapped log lines) more room.
const BUBBLE_MAX_WIDTH = 'max-w-[85%]!';

export default function ChatMessage({
    text,
    timestamp,
    sent,
    media,
    mediaState,
    mediaFullState,
    onMediaRequest,
    mediaObserve,
    editedAt,
    deleted,
    onRequestActions,
}: Props) {
    const type = sent ? 'sent' : 'received';

    const timeLabel =
        timestamp.getTime() === 0
            ? 'No timestamp'
            : timestamp.toLocaleTimeString();

    const edited = editedAt ? editedInfo(timestamp, editedAt) : null;

    if (deleted) {
        return (
            <Message
                data-testid="message"
                type={type}
                className={BUBBLE_MAX_WIDTH}
                colors={NEUTRAL_BUBBLE}
                text={
                    <>
                        <p className="text-sm italic opacity-50">[deleted]</p>
                        <p className="mt-1 text-xs opacity-50">{timeLabel}</p>
                    </>
                }
            />
        );
    }

    return (
        <Message
            data-testid="message"
            type={type}
            className={BUBBLE_MAX_WIDTH}
            text={
                <>
                    {onRequestActions && (
                        <button
                            type="button"
                            data-testid="message-actions-trigger"
                            aria-label="Message actions"
                            aria-haspopup="menu"
                            onClick={onRequestActions}
                            // Visible affordance (an opacity-0 hover-only trigger
                            // is invisible on touch). A faint scrim keeps the
                            // glyph legible on the blue bubble. Lower-right corner
                            // so it never sits over an image attachment (top).
                            className="absolute bottom-1 right-1 z-10 flex size-6 items-center justify-center rounded-full bg-black/10 text-current opacity-70 transition hover:bg-black/20 hover:opacity-100"
                        >
                            <EllipsisVertical className="size-4" />
                        </button>
                    )}
                    {media && onMediaRequest && (
                        <div className="mb-1">
                            <MediaAttachment
                                state={mediaState}
                                fullState={mediaFullState}
                                hasPreview={!!media.preview}
                                name={media.name}
                                size={media.size}
                                width={media.width}
                                height={media.height}
                                // Chip/retry loads the displayed object (preview
                                // if any); tap loads the full.
                                onRequest={() =>
                                    onMediaRequest(
                                        media.preview?.url ?? media.url,
                                    )
                                }
                                onRequestFull={() => onMediaRequest(media.url)}
                                observe={
                                    mediaObserve
                                        ? (el) =>
                                              mediaObserve(
                                                  media.preview?.url ??
                                                      media.url,
                                                  el,
                                              )
                                        : undefined
                                }
                            />
                        </div>
                    )}
                    {text && (
                        <p className="wrap-anywhere whitespace-pre-wrap text-sm">
                            {text}
                        </p>
                    )}
                    {/* Reserve room on the timestamp row for the lower-right
                        trigger so a long "edited …" tag doesn't run under it. */}
                    <p
                        className={`mt-1 text-xs ${
                            onRequestActions ? 'pe-6' : ''
                        }`}
                    >
                        <span className="opacity-50">{timeLabel}</span>
                        {edited && (
                            <span
                                data-testid="edited-tag"
                                title={edited.title}
                                className={`ml-1 ${EDITED_TIER_CLASS[edited.tier]}`}
                            >
                                · {edited.label}
                            </span>
                        )}
                    </p>
                </>
            }
        />
    );
}
