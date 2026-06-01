import { useState } from 'react';
import type { MediaState } from '@/hooks/useMedia';
import type { MediaFile } from '@/lib/media';
import MediaAttachment from './MediaAttachment';
import MessageActions from './MessageActions';

interface Props {
    text: string;
    timestamp: Date;
    sent: boolean;
    media?: MediaFile;
    mediaState?: MediaState;
    onMediaRetry?: (url: string) => void;
    // Amendment state (set by the materializer).
    editedAt?: Date;
    deleted?: boolean;
    // Amendment affordances (wired by the route for the user's own messages).
    // onStartEdit is provided only when the message is editable.
    editing?: boolean;
    onStartEdit?: () => void;
    onCancelEdit?: () => void;
    onSaveEdit?: (newBody: string) => void;
    onDelete?: () => void;
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

// Inline edit form. A child component so its draft state initializes from the
// current body each time editing begins (mount), with no effect needed.
function InlineEdit({
    initialValue,
    onSave,
    onCancel,
}: {
    initialValue: string;
    onSave: (v: string) => void;
    onCancel: () => void;
}) {
    const [value, setValue] = useState(initialValue);
    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                const v = value.trim();
                if (v) onSave(v);
            }}
            className="flex flex-col gap-1.5"
        >
            <input
                type="text"
                // biome-ignore lint/a11y/noAutofocus: editing is an explicit user action
                autoFocus
                data-testid="message-edit-input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="rounded border border-input bg-background px-2 py-1 text-sm text-foreground focus:border-ring focus:outline-none"
            />
            <div className="flex justify-end gap-2 text-xs">
                <button
                    type="button"
                    onClick={onCancel}
                    className="rounded px-2 py-0.5 hover:bg-black/10"
                >
                    Cancel
                </button>
                <button
                    type="submit"
                    data-testid="message-edit-save"
                    className="rounded bg-primary px-2 py-0.5 text-primary-foreground hover:bg-primary/90"
                >
                    Save
                </button>
            </div>
        </form>
    );
}

export default function ChatMessage({
    text,
    timestamp,
    sent,
    media,
    mediaState,
    onMediaRetry,
    editedAt,
    deleted,
    editing,
    onStartEdit,
    onCancelEdit,
    onSaveEdit,
    onDelete,
}: Props) {
    const bubbleClass = `group relative px-4 py-2.5 ${
        sent
            ? 'ml-8 rounded-tl-2xl rounded-bl-2xl rounded-br-2xl bg-bubble-sent text-bubble-sent-foreground'
            : 'mr-8 rounded-tr-2xl rounded-bl-2xl rounded-br-2xl bg-bubble-received text-bubble-received-foreground'
    }`;

    const timeLabel =
        timestamp.getTime() === 0
            ? 'No timestamp'
            : timestamp.toLocaleTimeString();

    const edited = editedAt ? editedInfo(timestamp, editedAt) : null;

    if (deleted) {
        return (
            <div data-testid="message" className={bubbleClass}>
                <p className="text-sm italic opacity-50">[deleted]</p>
                <p className="mt-1 text-xs opacity-50">{timeLabel}</p>
            </div>
        );
    }

    if (editing && onSaveEdit && onCancelEdit) {
        return (
            <div data-testid="message" className={bubbleClass}>
                <InlineEdit
                    initialValue={text}
                    onSave={onSaveEdit}
                    onCancel={onCancelEdit}
                />
            </div>
        );
    }

    // Actions are shown for the user's own messages (onDelete provided).
    const showActions = !!onDelete;

    return (
        <div data-testid="message" className={bubbleClass}>
            {showActions && (
                <MessageActions onEdit={onStartEdit} onDelete={onDelete} />
            )}
            {media && mediaState && onMediaRetry && (
                <div className="mb-1">
                    <MediaAttachment
                        state={mediaState}
                        name={media.name}
                        size={media.size}
                        onRetry={() => onMediaRetry(media.url)}
                    />
                </div>
            )}
            {text && <p className="text-sm">{text}</p>}
            <p className="mt-1 text-xs">
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
        </div>
    );
}
