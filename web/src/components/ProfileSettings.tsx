import {
    Block,
    BlockTitle,
    Button,
    List,
    ListInput,
    ListItem,
} from 'konsta/react';
import { useState } from 'react';
import { updateProfile } from '@/lib/api';

interface Props {
    handle: string;
    token: string;
    initialDisplayName?: string;
}

// Profile section of Settings (ADR-0023 / T2). No longer the page wrapper —
// settings.tsx owns the Page + Navbar; this is just a grouped-list section.
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
        <>
            <BlockTitle>Your handle</BlockTitle>
            <List strong inset>
                <ListItem
                    title={<span className="font-mono">{handle}</span>}
                    after={
                        <button
                            type="button"
                            onClick={copyHandle}
                            className="text-sm text-primary active:opacity-60"
                        >
                            {copied ? 'Copied' : 'Copy'}
                        </button>
                    }
                />
            </List>

            <BlockTitle>Display name</BlockTitle>
            <List strong inset>
                <ListInput
                    inputId="display-name"
                    type="text"
                    placeholder="How others see you"
                    value={displayName}
                    maxLength={64}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        setDisplayName(e.target.value)
                    }
                />
            </List>
            <Block className="space-y-2">
                <Button
                    rounded
                    onClick={handleSave}
                    disabled={!dirty || saving}
                >
                    {saving ? 'Saving…' : 'Save'}
                </Button>
                {saved && (
                    <p className="text-center text-sm text-green-600">Saved</p>
                )}
                {error && (
                    <p className="text-center text-sm text-red-500">{error}</p>
                )}
            </Block>
        </>
    );
}
