import { Messagebar, Navbar, NavbarBackLink, Page } from 'konsta/react';
import { File as FileIcon, Paperclip, SendHorizontal, X } from 'lucide-react';
import { useState } from 'react';
import type { Message } from '@/hooks/useChat';
import type { PendingAttachment } from '@/hooks/useComposeAttachment';
import type { MediaState } from '@/hooks/useMedia';
import { formatBytes } from '@/lib/utils';
import ChatMessage from './ChatMessage';
import { JumpToBottomButton } from './JumpToBottomButton';

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
    onEditMessage?: (id: string, newBody: string) => void;
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
    onEditMessage,
    onDeleteMessage,
    scrollContainerRef,
    showJumpToBottom = false,
    onJumpToBottom,
}: Props) {
    // Which message is in inline-edit mode. Only one at a time — starting an
    // edit on another message replaces the target.
    const [editingId, setEditingId] = useState<string | null>(null);

    const inputsDisabled = sending || !encryptionReady || !online;
    // Send is enabled with text OR a staged attachment (a caption-less image is
    // a valid send).
    const canSend = !inputsDisabled && (!!inputValue.trim() || !!pending);

    const submit = () => {
        if (!canSend) return;
        if (pending && onSendMedia) {
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
    // clipboard content (text) pastes through untouched.
    const handlePaste = (e: React.ClipboardEvent) => {
        if (!onAttach) return;
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
        if (!onAttach) return;
        const file = e.dataTransfer?.files?.[0];
        if (file) {
            e.preventDefault();
            onAttach(file);
        }
    };
    const handleDragOver = (e: React.DragEvent) => {
        if (onAttach) e.preventDefault();
    };

    const placeholder = pending
        ? 'Add a caption…'
        : online
          ? 'Type a message...'
          : 'You are offline';

    // Attach + send ride the Messagebar's left/right slots. The attach <label>
    // wraps the hidden file input (kept for the e2e setInputFiles path); send is
    // a button with a stable "Send" accessible name even while disabled.
    const attachControl = onAttach ? (
        <label
            data-testid="attach-button"
            aria-label="Attach file"
            aria-disabled={inputsDisabled}
            className={`flex size-9 items-center justify-center rounded-full text-primary ${
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

    const sendControl = (
        <button
            type="button"
            aria-label="Send"
            disabled={!canSend}
            onClick={submit}
            className="flex size-9 items-center justify-center rounded-full text-primary disabled:opacity-40"
        >
            <SendHorizontal className="size-5" />
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
                <div
                    ref={scrollContainerRef}
                    className="flex-1 overflow-y-auto"
                >
                    <div className="mx-auto max-w-2xl px-4 py-4">
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
                            <div className="space-y-3">
                                {messages.map((msg) => {
                                    // Own, non-deleted messages can be amended.
                                    // Edit is offered only for text or a media
                                    // caption (not a pure-media bubble).
                                    const canAmend =
                                        msg.sent &&
                                        !msg.deleted &&
                                        !!onDeleteMessage;
                                    const canEdit =
                                        canAmend &&
                                        !!onEditMessage &&
                                        (!msg.media || msg.text !== '');
                                    return (
                                        <ChatMessage
                                            key={msg.id}
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
                                                    ? mediaStates[msg.media.url]
                                                    : undefined
                                            }
                                            onMediaRequest={onMediaRequest}
                                            mediaObserve={mediaObserve}
                                            editedAt={msg.editedAt}
                                            deleted={msg.deleted}
                                            editing={editingId === msg.id}
                                            onStartEdit={
                                                canEdit
                                                    ? () => setEditingId(msg.id)
                                                    : undefined
                                            }
                                            onCancelEdit={() =>
                                                setEditingId(null)
                                            }
                                            onSaveEdit={
                                                onEditMessage
                                                    ? (body) => {
                                                          onEditMessage(
                                                              msg.id,
                                                              body,
                                                          );
                                                          setEditingId(null);
                                                      }
                                                    : undefined
                                            }
                                            onDelete={
                                                canAmend
                                                    ? () =>
                                                          onDeleteMessage(
                                                              msg.id,
                                                              msg.media
                                                                  ? [
                                                                        msg
                                                                            .media
                                                                            .url,
                                                                        msg
                                                                            .media
                                                                            .preview
                                                                            ?.url,
                                                                    ].filter(
                                                                        (
                                                                            u,
                                                                        ): u is string =>
                                                                            !!u,
                                                                    )
                                                                  : undefined,
                                                          )
                                                    : undefined
                                            }
                                        />
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
                {showJumpToBottom && (
                    <JumpToBottomButton
                        onClick={onJumpToBottom ?? (() => {})}
                    />
                )}
            </div>

            {/* Composer — staged attachment tray (when any) above the Messagebar */}
            <div className="bg-background">
                {pending && (
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
                )}
                <Messagebar
                    className="relative!"
                    value={inputValue}
                    placeholder={placeholder}
                    textareaId="message-input"
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                        setInputValue(e.target.value)
                    }
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    left={attachControl}
                    right={sendControl}
                />
            </div>
        </Page>
    );
}
