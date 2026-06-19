interface Props {
    onLogout: () => void;
}

// Minimal sign-out, moved here from the chats screen during the Konsta migration
// (ADR-0023 / T1). Still shadcn — T2 restyles the Settings screen in Konsta.
export default function SignOutPanel({ onLogout }: Props) {
    return (
        <div className="mt-8 border-t border-border pt-6">
            <button
                type="button"
                onClick={onLogout}
                className="rounded border border-border px-4 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
                Sign out
            </button>
        </div>
    );
}
