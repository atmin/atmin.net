import {
    Messagebar,
    Messages,
    Navbar,
    NavbarBackLink,
    Page,
} from 'konsta/react';
import {
    Check,
    File as FileIcon,
    Paperclip,
    Pencil,
    SendHorizontal,
    X,
} from 'lucide-react';
import { Fragment, useState } from 'react';
import type { Message } from '@/hooks/useChat';
import type { PendingAttachment } from '@/hooks/useComposeAttachment';
import type { MediaState } from '@/hooks/useMedia';
import { dayKey, dayLabel } from '@/lib/timeline';
import { formatBytes } from '@/lib/utils';
import ChatMessage from './ChatMessage';
import { JumpToBottomButton } from './JumpToBottomButton';
import MessageActions from './MessageActions';

interface Props {
    chatTitle: string;
    isSaved: boolean;
    handle: string;
    /** Back to the conversation list. Plain navigate (no reverse transition). */
    onBack: () => void;
    messages: Message[];
    loading: boolean;
    sending: boolean;
    online: boolean;
    encryptionReady: boolean;
    mediaStates?: Record<string, MediaState>;
    onMediaRequest?: (url: string) => void;
    mediaObserve?: (url: string, el: HTMLElement | null) => void;
    onSend: (text: string) => void;
    onSendMedia?: (file: File, caption?: string) => void;
    // Compose-tray staging (P1d). The pending attachment + its lifecycle live in
    // useComposeAttachment in the route; the tray markup lives here. Absent when
    // the route doesn't wire media (e.g. a read-only view).
    pending?: PendingAttachment | null;
    onAttach?: (file: File) => void;
    onClearAttachment?: () => void;
    // Controlled draft input — persisted across reloads by useDraft in the
    // route. setInputValue('') after a send both clears the field and removes
    // the stored draft key.
    inputValue: string;
    setInputValue: (v: string) => void;
    // Editing reuses the composer (route-owned state). editingId marks the bubble
    // being edited; editValue is the live edit buffer (kept separate so the draft
    // survives). onStartEdit loads a message in; onCommitEdit saves; onCancelEdit
    // drops it. Edit is offered for a message only when onStartEdit is wired.
    editingId?: string | null;
    editValue?: string;
    onEditValueChange?: (v: string) => void;
    onStartEdit?: (id: string, body: string) => void;
    onCancelEdit?: () => void;
    onCommitEdit?: () => void;
    onDeleteMessage?: (id: string, mediaUrls?: string[]) => void;
    scrollContainerRef?: (el: HTMLDivElement | null) => void;
    showJumpToBottom?: boolean;
    onJumpToBottom?: () => void;
}

export default function ChatView({
    chatTitle,
    isSaved,
    handle,
    onBack,
    messages,
    loading,
    sending,
    online,
    encryptionReady,
    mediaStates = {},
    onMediaRequest = () => {},
    mediaObserve,
    onSend,
    onSendMedia,
    pending,
    onAttach,
    onClearAttachment,
    inputValue,
    setInputValue,
    editingId = null,
    editValue = '',
    onEditValueChange,
    onStartEdit,
    onCancelEdit,
    onCommitEdit,
    onDeleteMessage,
    scrollContainerRef,
    showJumpToBottom = false,
    onJumpToBottom,
}: Props) {
    // Which message's action sheet is open. Lifted out of the bubble because the
    // Konsta Actions sheet positions with `fixed` and must not sit inside a
    // transform-ed `k-message` (which would trap it to the bubble's box).
    const [actionsId, setActionsId] = useState<string | null>(null);

    const editing = editingId !== null;
    const inputsDisabled = sending || !encryptionReady || !online;
    // Reference point for the timeline day-dividers ("Today" / "Yesterday" / a
    // date). Read once per render — recomputing in the map would be the same
    // wall-clock for every row anyway.
    const now = new Date();
    // Editing commits a text amendment; composing sends text OR a staged image
    // (a caption-less image is a valid send).
    const canSend = editing
        ? !inputsDisabled && !!editValue.trim()
        : !inputsDisabled && (!!inputValue.trim() || !!pending);

    const submit = () => {
        if (!canSend) return;
        if (editing) {
            onCommitEdit?.();
        } else if (pending && onSendMedia) {
            // One media message; the typed text becomes its caption (sendMedia
            // falls back to the filename when empty). Clear both the draft and
            // the staged attachment on success-path dispatch.
            onSendMedia(pending.file, inputValue);
            setInputValue('');
            onClearAttachment?.();
        } else {
            onSend(inputValue.trim());
            setInputValue('');
        }
    };

    // The Messagebar textarea is multi-line; Enter sends (Shift+Enter inserts a
    // newline), matching desktop chat expectations. isComposing guards IME input
    // so committing a CJK candidate with Enter doesn't fire a send. Konsta doesn't
    // forward onKeyDown to the textarea, so this rides the messagebar root div and
    // catches the bubbling event.
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
        }
    };

    // Clipboard paste of an image stages it instead of sending; any non-image
    // clipboard content (text) pastes through untouched. No staging while editing
    // (an edit is text-only).
    const handlePaste = (e: React.ClipboardEvent) => {
        if (!onAttach || editing) return;
        const items = e.clipboardData?.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === 'file' && item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) {
                    e.preventDefault();
                    onAttach(file);
                    return;
                }
            }
        }
    };

    // Drag-drop stages the first dropped file (image or not — non-images show a
    // chip). dragOver must preventDefault so the browser fires the drop.
    const handleDrop = (e: React.DragEvent) => {
        if (!onAttach || editing) return;
        const file = e.dataTransfer?.files?.[0];
        if (file) {
            e.preventDefault();
            onAttach(file);
        }
    };
    const handleDragOver = (e: React.DragEvent) => {
        if (onAttach && !editing) e.preventDefault();
    };

    const placeholder = editing
        ? 'Edit message…'
        : pending
          ? 'Add a caption…'
          : online
            ? 'Type a message...'
            : 'You are offline';

    // The message whose action sheet is open, plus whether it offers Edit (text
    // or captioned media — never a pure-media bubble). Resolving by id (not a
    // stored object) keeps the sheet honest if the message re-materializes.
    const actionsMsg = actionsId
        ? messages.find((m) => m.id === actionsId)
        : undefined;
    const actionsCanEdit =
        !!actionsMsg &&
        !!onStartEdit &&
        (!actionsMsg.media || actionsMsg.text !== '');

    // The blob keys a media delete must also remove (display object + preview).
    const mediaUrlsOf = (m: Message): string[] | undefined =>
        m.media
            ? [m.media.url, m.media.preview?.url].filter(
                  (u): u is string => !!u,
              )
            : undefined;

    // Attach (composing only) + send/save ride the Messagebar's left/right slots.
    // The attach <label> wraps the hidden file input (kept for the e2e
    // setInputFiles path). Attaching is hidden while editing — an edit is
    // text-only.
    const attachControl =
        onAttach && !editing ? (
            <label
                data-testid="attach-button"
                aria-label="Attach file"
                aria-disabled={inputsDisabled}
                className={`flex size-8 -translate-y-2.5 items-center justify-center rounded-full text-primary ${
                    inputsDisabled
                        ? 'pointer-events-none opacity-40'
                        : 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/10'
                }`}
            >
                <Paperclip className="size-5" />
                <input
                    type="file"
                    className="hidden"
                    disabled={inputsDisabled}
                    onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) onAttach(f);
                        e.target.value = '';
                    }}
                />
            </label>
        ) : undefined;

    // Send (compose) / Save (edit) — a stable accessible name per mode so e2e and
    // SRs can target it; the glyph switches to a check while editing.
    const sendControl = (
        <button
            type="button"
            aria-label={editing ? 'Save edit' : 'Send'}
            disabled={!canSend}
            onClick={submit}
            className="flex size-8 -translate-y-2.5 items-center justify-center rounded-full text-primary disabled:opacity-40"
        >
            {editing ? (
                <Check className="size-5" />
            ) : (
                <SendHorizontal className="size-5" />
            )}
        </button>
    );

    return (
        // Flex column instead of Konsta's default page scroll: the inner messages
        // div owns the scroll (so useChatScroll's contract is unchanged) and the
        // composer flows in-document at the bottom (Messagebar is forced relative,
        // overriding its fixed-bottom default — see the override below).
        <Page className="flex flex-col overflow-hidden!">
            <Navbar
                title={
                    isSaved ? (
                        chatTitle
                    ) : (
                        <span className="font-mono">{chatTitle}</span>
                    )
                }
                left={<NavbarBackLink text="Chats" onClick={onBack} />}
            />

            <div className="relative flex flex-1 flex-col overflow-hidden">
                {/* overflow-x-hidden: a self-end bubble of unbreakable text must
                    not be able to widen the column and spawn a horizontal
                    scrollbar (overflow-y-auto alone computes overflow-x to auto). */}
                <div
                    ref={scrollContainerRef}
                    className="flex-1 overflow-y-auto overflow-x-hidden"
                >
                    <div className="mx-auto max-w-2xl px-1 py-4">
                        {loading ? (
                            <div className="flex h-96 items-center justify-center text-muted-foreground">
                                <p>Loading messages...</p>
                            </div>
                        ) : messages.length === 0 ? (
                            <div className="flex h-96 items-center justify-center text-center text-muted-foreground">
                                <div>
                                    <p className="mb-2">No messages yet</p>
                                    <p className="text-xs">
                                        {isSaved
                                            ? 'Send yourself notes and reminders'
                                            : `Start a conversation with ${handle}`}
                                    </p>
                                </div>
                            </div>
                        ) : (
                            <Messages className="mb-2! bg-transparent">
                                {messages.map((msg, i) => {
                                    // Own, non-deleted messages can be amended
                                    // via the action sheet (lifted to ChatView).
                                    const canAmend =
                                        msg.sent &&
                                        !msg.deleted &&
                                        !!onDeleteMessage;
                                    // A divider precedes the first message of
                                    // each local calendar day. messages are
                                    // ordered oldest→newest, so compare against
                                    // the previous row's day (the first row
                                    // always opens a day). Plain in-map
                                    // derivation — no lifecycle hook.
                                    const prev = messages[i - 1];
                                    const newDay =
                                        !prev ||
                                        dayKey(msg.timestamp) !==
                                            dayKey(prev.timestamp);
                                    return (
                                        <Fragment key={msg.id}>
                                            {newDay && (
                                                // Day divider — a centered pill
                                                // that pins to the top of the
                                                // timeline as you scroll, so the
                                                // current day is always in view.
                                                // Not Konsta's MessagesTitle: it
                                                // drops className (so no margin /
                                                // sticky) and crowds the bubbles.
                                                // The row is transparent + full
                                                // width to catch the top edge;
                                                // only the blurred pill paints, so
                                                // bubbles scroll legibly under it.
                                                <div
                                                    data-testid="day-separator"
                                                    className="sticky top-2 z-10 my-3 flex justify-center"
                                                >
                                                    <span className="w-36 rounded-full bg-background/80 px-3 py-1 text-center text-xs font-medium whitespace-nowrap text-muted-foreground backdrop-blur-sm">
                                                        {dayLabel(
                                                            msg.timestamp,
                                                            now,
                                                        )}
                                                    </span>
                                                </div>
                                            )}
                                            <ChatMessage
                                                text={msg.text}
                                                timestamp={msg.timestamp}
                                                sent={msg.sent}
                                                media={msg.media}
                                                mediaState={
                                                    msg.media
                                                        ? mediaStates[
                                                              msg.media.preview
                                                                  ?.url ??
                                                                  msg.media.url
                                                          ]
                                                        : undefined
                                                }
                                                mediaFullState={
                                                    msg.media
                                                        ? mediaStates[
                                                              msg.media.url
                                                          ]
                                                        : undefined
                                                }
                                                onMediaRequest={onMediaRequest}
                                                mediaObserve={mediaObserve}
                                                editedAt={msg.editedAt}
                                                deleted={msg.deleted}
                                                onRequestActions={
                                                    canAmend
                                                        ? () =>
                                                              setActionsId(
                                                                  msg.id,
                                                              )
                                                        : undefined
                                                }
                                            />
                                        </Fragment>
                                    );
                                })}
                            </Messages>
                        )}
                    </div>
                </div>
                {showJumpToBottom && (
                    <JumpToBottomButton
                        onClick={onJumpToBottom ?? (() => {})}
                    />
                )}
            </div>

            {/* Composer footer. While editing: an "Editing message" banner with a
                cancel. Otherwise: the staged-attachment tray (when any). */}
            <div className="bg-background">
                {editing ? (
                    <div
                        data-testid="edit-banner"
                        className="flex items-center gap-2 px-4 pt-2 text-sm"
                    >
                        <Pencil className="size-4 text-primary" aria-hidden />
                        <span className="font-medium text-primary">
                            Editing message
                        </span>
                        <button
                            type="button"
                            data-testid="edit-cancel"
                            aria-label="Cancel edit"
                            onClick={onCancelEdit}
                            className="ml-auto flex size-7 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10"
                        >
                            <X className="size-4" />
                        </button>
                    </div>
                ) : (
                    pending && (
                        <div className="px-3 pt-3">
                            <div
                                data-testid="compose-tray"
                                className="flex items-center gap-3 rounded-xl bg-black/5 p-2 dark:bg-white/10"
                            >
                                {pending.isImage ? (
                                    <img
                                        data-testid="compose-thumb"
                                        src={pending.previewUrl}
                                        alt={pending.file.name}
                                        className="size-16 rounded-lg object-cover"
                                    />
                                ) : (
                                    <div
                                        data-testid="compose-file"
                                        className="flex min-w-0 flex-1 items-center gap-2"
                                    >
                                        <FileIcon
                                            className="size-4 shrink-0 opacity-70"
                                            aria-hidden
                                        />
                                        <span className="min-w-0">
                                            <span className="block truncate text-sm">
                                                {pending.file.name}
                                            </span>
                                            <span className="block text-xs opacity-70">
                                                {formatBytes(pending.file.size)}
                                            </span>
                                        </span>
                                    </div>
                                )}
                                <button
                                    type="button"
                                    data-testid="compose-remove"
                                    aria-label="Remove attachment"
                                    onClick={() => onClearAttachment?.()}
                                    className="ml-auto flex size-8 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10"
                                >
                                    <X className="size-4" />
                                </button>
                            </div>
                        </div>
                    )
                )}
                <Messagebar
                    className="relative!"
                    leftClassName="-ms-1"
                    rightClassName="-me-1"
                    value={editing ? editValue : inputValue}
                    placeholder={placeholder}
                    textareaId="message-input"
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                        editing
                            ? onEditValueChange?.(e.target.value)
                            : setInputValue(e.target.value)
                    }
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    left={attachControl}
                    right={sendControl}
                />
            </div>

            {/* One action sheet for the whole timeline, keyed to the bubble
                whose ⋯ was tapped. Rendered here — outside the transform-ed
                message bubbles — so its fixed-positioned overlay fills the
                viewport rather than a single bubble's box. */}
            <MessageActions
                opened={!!actionsMsg}
                canEdit={actionsCanEdit}
                onEdit={() => {
                    if (actionsMsg) {
                        onStartEdit?.(actionsMsg.id, actionsMsg.text);
                        // Focus the composer so the loaded text is ready to edit
                        // (imperative DOM in an event handler — not a lifecycle).
                        document.getElementById('message-input')?.focus();
                    }
                    setActionsId(null);
                }}
                onDelete={() => {
                    if (actionsMsg && onDeleteMessage)
                        onDeleteMessage(actionsMsg.id, mediaUrlsOf(actionsMsg));
                    setActionsId(null);
                }}
                onClose={() => setActionsId(null)}
            />
        </Page>
    );
}
