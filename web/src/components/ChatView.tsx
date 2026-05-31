import { useState } from 'react';
import type { Message } from '@/hooks/useChat';
import type { MediaState } from '@/hooks/useMedia';
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
    onMediaRetry?: (url: string) => void;
    onSend: (text: string) => void;
    onSendMedia?: (file: File) => void;
    // Controlled draft input — persisted across reloads by useDraft in the
    // route. setInputValue('') after a send both clears the field and removes
    // the stored draft key.
    inputValue: string;
    setInputValue: (v: string) => void;
    onEditMessage?: (id: string, newBody: string) => void;
    onDeleteMessage?: (id: string, mediaUrl?: string) => void;
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
    onMediaRetry = () => {},
    onSend,
    onSendMedia,
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

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const text = inputValue.trim();
        if (!text || sending || !online) return;
        onSend(text);
        setInputValue('');
    };

    const inputsDisabled = sending || !encryptionReady || !online;

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
                            <div className="flex h-96 items-center justify-center rounded border border-dashed border-border text-center text-muted-foreground">
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
                                                    ? mediaStates[msg.media.url]
                                                    : undefined
                                            }
                                            onMediaRetry={onMediaRetry}
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
                                                              msg.media?.url,
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

            {/* Message input */}
            <div className="border-t border-border bg-background px-4 py-3">
                <form
                    onSubmit={handleSubmit}
                    className="mx-auto flex max-w-2xl gap-2"
                >
                    {onSendMedia && (
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
                                    if (f) onSendMedia(f);
                                    e.target.value = '';
                                }}
                            />
                        </label>
                    )}
                    <input
                        type="text"
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        placeholder={
                            online ? 'Type a message...' : 'You are offline'
                        }
                        className="flex-1 rounded border border-input bg-background px-3 py-2 text-sm focus:border-ring focus:outline-none"
                    />
                    <button
                        type="submit"
                        disabled={!inputValue.trim() || inputsDisabled}
                        className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                        {sending ? 'Sending...' : 'Send'}
                    </button>
                </form>
            </div>
        </Layout>
    );
}
