import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Message } from '@/hooks/useChat';
import type { MediaState } from '@/hooks/useMedia';
import ChatMessage from './ChatMessage';

interface Props {
    chatTitle: string;
    isSaved: boolean;
    handle: string;
    messages: Message[];
    loading: boolean;
    sending: boolean;
    encryptionReady: boolean;
    mediaStates?: Record<string, MediaState>;
    onMediaRetry?: (url: string) => void;
    onSend: (text: string) => void;
    onSendMedia?: (file: File) => void;
}

export default function ChatView({
    chatTitle,
    isSaved,
    handle,
    messages,
    loading,
    sending,
    encryptionReady,
    mediaStates = {},
    onMediaRetry = () => {},
    onSend,
    onSendMedia,
}: Props) {
    const [inputValue, setInputValue] = useState('');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const text = inputValue.trim();
        if (!text || sending) return;
        onSend(text);
        setInputValue('');
    };

    return (
        <div className="flex min-h-screen flex-col bg-background">
            {/* Header */}
            <div className="border-b border-border bg-background px-4 py-3">
                <div className="mx-auto flex max-w-2xl items-center gap-3">
                    <Link
                        to="/"
                        className="text-muted-foreground hover:text-foreground"
                    >
                        ← Back
                    </Link>
                    <h2 className="font-mono text-sm font-medium">
                        {chatTitle}
                    </h2>
                </div>
            </div>

            {/* Messages area */}
            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto max-w-2xl p-4">
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
                            {messages.map((msg) => (
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
                                />
                            ))}
                        </div>
                    )}
                </div>
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
                            aria-disabled={sending || !encryptionReady}
                            className={`rounded border border-input px-3 py-2 text-sm hover:bg-accent ${
                                sending || !encryptionReady
                                    ? 'pointer-events-none opacity-50'
                                    : 'cursor-pointer'
                            }`}
                        >
                            📎
                            <input
                                type="file"
                                className="hidden"
                                disabled={sending || !encryptionReady}
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
                        placeholder="Type a message..."
                        className="flex-1 rounded border border-input bg-background px-3 py-2 text-sm focus:border-ring focus:outline-none"
                    />
                    <button
                        type="submit"
                        disabled={
                            !inputValue.trim() || sending || !encryptionReady
                        }
                        className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                        {sending ? 'Sending...' : 'Send'}
                    </button>
                </form>
            </div>
        </div>
    );
}
