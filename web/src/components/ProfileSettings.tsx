import { ChevronLeft } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { updateProfile } from '@/lib/api';
import Layout from './Layout';

interface Props {
    handle: string;
    token: string;
    initialDisplayName?: string;
    children?: ReactNode;
}

export default function ProfileSettings({
    handle,
    token,
    initialDisplayName = '',
    children,
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

    const topBar = (
        <div className="mx-auto flex w-full max-w-2xl items-center gap-1 font-mono">
            <Link
                to="/"
                className="text-muted-foreground hover:text-foreground"
            >
                <ChevronLeft className="h-5 w-5" />
            </Link>
            <span className="text-sm font-medium">Settings</span>
        </div>
    );

    return (
        <Layout topBar={topBar}>
            <div className="mx-auto max-w-2xl px-8 pb-8 pt-20 font-mono text-sm">
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

                {children}
            </div>
        </Layout>
    );
}
