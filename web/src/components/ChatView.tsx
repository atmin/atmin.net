import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Message } from '@/hooks/useChat';

interface Props {
    chatTitle: string;
    isSaved: boolean;
    handle: string;
    messages: Message[];
    loading: boolean;
    sending: boolean;
    onSend: (text: string) => void;
}

export default function ChatView({
    chatTitle,
    isSaved,
    handle,
    messages,
    loading,
    sending,
    onSend,
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
        <div className="flex min-h-screen flex-col bg-stone-50">
            {/* Header */}
            <div className="border-b border-stone-200 bg-white px-4 py-3">
                <div className="mx-auto flex max-w-2xl items-center gap-3">
                    <Link
                        to="/"
                        className="text-stone-400 hover:text-stone-600"
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
                        <div className="flex h-96 items-center justify-center text-stone-400">
                            <div className="text-center">
                                <p>Loading messages...</p>
                            </div>
                        </div>
                    ) : messages.length === 0 ? (
                        <div className="flex h-96 items-center justify-center rounded border border-dashed border-stone-300 text-center text-stone-400">
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
                                <div
                                    key={msg.id}
                                    className="rounded bg-white p-3 shadow-sm"
                                >
                                    <p className="text-sm">{msg.text}</p>
                                    <p className="mt-1 text-xs text-stone-400">
                                        {msg.timestamp.getTime() === 0
                                            ? 'No timestamp'
                                            : msg.timestamp.toLocaleTimeString()}
                                    </p>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Message input */}
            <div className="border-t border-stone-200 bg-white px-4 py-3">
                <form
                    onSubmit={handleSubmit}
                    className="mx-auto flex max-w-2xl gap-2"
                >
                    <input
                        type="text"
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        placeholder="Type a message..."
                        className="flex-1 rounded border border-stone-300 px-3 py-2 text-sm focus:border-stone-400 focus:outline-none"
                    />
                    <button
                        type="submit"
                        disabled={!inputValue.trim() || sending}
                        className="rounded bg-stone-800 px-4 py-2 text-sm text-white hover:bg-stone-700 disabled:bg-stone-300"
                    >
                        {sending ? 'Sending...' : 'Send'}
                    </button>
                </form>
            </div>
        </div>
    );
}
