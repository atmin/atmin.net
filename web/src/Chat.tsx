import { Link, useParams } from 'react-router-dom';
import type { Session } from './session';

interface Props {
    session: Session;
}

export default function Chat({ session: _session }: Props) {
    const { handle } = useParams<{ handle: string }>();
    const isSaved = handle === 'saved';
    const chatTitle = isSaved ? 'Saved Messages' : handle;

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
                </div>
            </div>

            {/* Message input */}
            <div className="border-t border-stone-200 bg-white px-4 py-3">
                <div className="mx-auto max-w-2xl">
                    <input
                        type="text"
                        placeholder="Type a message..."
                        disabled
                        className="w-full rounded border border-stone-300 px-3 py-2 text-sm"
                    />
                </div>
            </div>
        </div>
    );
}
