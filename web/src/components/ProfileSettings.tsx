import { useState } from 'react';
import { Link } from 'react-router-dom';
import { updateProfile } from '@/lib/api';

interface Props {
    handle: string;
    token: string;
    initialDisplayName?: string;
}

export default function ProfileSettings({
    handle,
    token,
    initialDisplayName = '',
}: Props) {
    const [displayName, setDisplayName] = useState(initialDisplayName);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const dirty = displayName.trim() !== initialDisplayName;

    const handleSave = async () => {
        setSaving(true);
        setError(null);
        setSaved(false);
        try {
            await updateProfile(token, { display_name: displayName.trim() });
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save');
        } finally {
            setSaving(false);
        }
    };

    const copyHandle = () => {
        navigator.clipboard.writeText(handle);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="min-h-screen bg-background p-8 font-mono text-sm">
            <div className="mx-auto max-w-md">
                <Link
                    to="/"
                    className="mb-6 inline-block text-xs text-muted-foreground hover:text-foreground"
                >
                    &larr; Back to chats
                </Link>

                <h1 className="mb-8 text-2xl font-bold">Settings</h1>

                <div className="mb-6 rounded bg-muted p-4">
                    <p className="mb-1 text-xs text-muted-foreground">
                        Your handle
                    </p>
                    <div className="flex items-center justify-between">
                        <span className="text-lg">{handle}</span>
                        <button
                            type="button"
                            onClick={copyHandle}
                            className="text-xs text-muted-foreground hover:text-foreground"
                        >
                            {copied ? 'Copied' : 'Copy'}
                        </button>
                    </div>
                </div>

                <div className="space-y-4">
                    <div>
                        <label
                            htmlFor="display-name"
                            className="mb-1 block text-xs text-muted-foreground"
                        >
                            Display name
                        </label>
                        <input
                            id="display-name"
                            type="text"
                            value={displayName}
                            onChange={(e) => setDisplayName(e.target.value)}
                            placeholder="How others see you"
                            className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:border-ring focus:outline-none"
                            maxLength={64}
                        />
                    </div>

                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={!dirty || saving}
                        className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                        {saving ? 'Saving...' : 'Save'}
                    </button>

                    {saved && <p className="text-xs text-green-600">Saved</p>}
                    {error && (
                        <p className="text-xs text-destructive">{error}</p>
                    )}
                </div>
            </div>
        </div>
    );
}
