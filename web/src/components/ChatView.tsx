import { File as FileIcon } from 'lucide-react';
import { useState } from 'react';
import type { Message } from '@/hooks/useChat';
import type { PendingAttachment } from '@/hooks/useComposeAttachment';
import type { MediaState } from '@/hooks/useMedia';
import { formatBytes } from '@/lib/utils';
import BackButton from './BackButton';
import ChatMessage from './ChatMessage';
import { JumpToBottomButton } from './JumpToBottomButton';
import Layout from './Layout';

interface Props {
    chatTitle: string;
    isSaved: boolean;
    handle: string;
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

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
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

    const topBar = (
        <>
            <BackButton />
            <h2 className="ml-1 font-mono text-sm font-medium">{chatTitle}</h2>
        </>
    );

    return (
        <Layout fullHeight topBar={topBar}>
            {/* Messages area */}
            <div className="relative flex flex-1 flex-col overflow-hidden">
                <div
                    ref={scrollContainerRef}
                    className="flex-1 overflow-y-auto"
                >
                    <div className="mx-auto max-w-2xl px-4 pb-4 pt-14">
                        {loading ? (
                            <div className="flex h-96 items-center justify-center text-muted-foreground">
                                <div className="text-center">
                                    <p>Loading messages...</p>
                                </div>
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

            {/* Compose area — staged attachment tray (when any) above the row */}
            <div className="bg-background px-4 py-3">
                <form
                    onSubmit={handleSubmit}
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    className="mx-auto flex max-w-2xl flex-col gap-2"
                >
                    {pending && (
                        <div
                            data-testid="compose-tray"
                            className="flex items-center gap-3 rounded-lg border border-input bg-muted/40 p-2"
                        >
                            {pending.isImage ? (
                                <img
                                    data-testid="compose-thumb"
                                    src={pending.previewUrl}
                                    alt={pending.file.name}
                                    className="size-16 rounded object-cover"
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
                                className="ml-auto rounded px-2 py-1 text-sm hover:bg-accent"
                            >
                                ✕
                            </button>
                        </div>
                    )}
                    <div className="flex gap-2">
                        {onAttach && (
                            <label
                                data-testid="attach-button"
                                aria-label="Attach file"
                                aria-disabled={inputsDisabled}
                                className={`rounded border border-input px-3 py-2 text-sm hover:bg-accent ${
                                    inputsDisabled
                                        ? 'pointer-events-none opacity-50'
                                        : 'cursor-pointer'
                                }`}
                            >
                                📎
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
                        )}
                        <input
                            type="text"
                            data-testid="message-input"
                            value={inputValue}
                            onChange={(e) => setInputValue(e.target.value)}
                            onPaste={handlePaste}
                            placeholder={
                                pending
                                    ? 'Add a caption…'
                                    : online
                                      ? 'Type a message...'
                                      : 'You are offline'
                            }
                            className="flex-1 rounded border border-input bg-background px-3 py-2 text-sm focus:border-ring focus:outline-none"
                        />
                        <button
                            type="submit"
                            disabled={!canSend}
                            className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                        >
                            {sending ? 'Sending...' : 'Send'}
                        </button>
                    </div>
                </form>
            </div>
        </Layout>
    );
}
