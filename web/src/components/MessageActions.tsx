import { useState } from 'react';

interface Props {
    // Edit is offered only when editable (text or media-with-caption). Omit to
    // hide the Edit item (e.g. a pure-media message).
    onEdit?: () => void;
    onDelete: () => void;
}

// Per-bubble action menu for the user's own messages. A subtle trigger that is
// revealed on hover (desktop) and always tappable (touch); opening it shows
// Edit / Delete. Delete is two-step — picking it swaps the menu for a confirm
// prompt, since a delete propagates to every recipient and can't be undone.
// Pure presentational state only — the edit/delete effects live in
// useChatAmendments, wired through the route.
export default function MessageActions({ onEdit, onDelete }: Props) {
    const [open, setOpen] = useState(false);
    const [confirmingDelete, setConfirmingDelete] = useState(false);

    const close = () => {
        setOpen(false);
        setConfirmingDelete(false);
    };

    return (
        <div className="absolute right-1 top-1">
            <button
                type="button"
                data-testid="message-actions-trigger"
                aria-label="Message actions"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => (open ? close() : setOpen(true))}
                className="rounded px-1.5 text-xs leading-none opacity-0 transition-opacity hover:bg-black/10 focus:opacity-100 group-hover:opacity-60"
            >
                ⋯
            </button>
            {/* Click-catcher: closes the menu on any outside click without a
                document-level listener (which the components layer disallows).
                The panels below sit above it (z-20), so their buttons fire. */}
            {open && (
                <button
                    type="button"
                    aria-label="Close menu"
                    tabIndex={-1}
                    onClick={close}
                    className="fixed inset-0 z-10 cursor-default"
                />
            )}
            {open && !confirmingDelete && (
                <div
                    role="menu"
                    className="absolute right-0 z-20 mt-1 min-w-24 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
                >
                    {onEdit && (
                        <button
                            type="button"
                            role="menuitem"
                            data-testid="message-action-edit"
                            onClick={() => {
                                close();
                                onEdit();
                            }}
                            className="block w-full px-3 py-1.5 text-left text-sm hover:bg-accent"
                        >
                            Edit
                        </button>
                    )}
                    <button
                        type="button"
                        role="menuitem"
                        data-testid="message-action-delete"
                        onClick={() => setConfirmingDelete(true)}
                        className="block w-full px-3 py-1.5 text-left text-sm text-destructive hover:bg-accent"
                    >
                        Delete
                    </button>
                </div>
            )}
            {open && confirmingDelete && (
                <div
                    role="menu"
                    data-testid="message-delete-confirm-prompt"
                    className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md"
                >
                    <p className="px-1 py-0.5 text-xs text-muted-foreground">
                        Delete this message for everyone?
                    </p>
                    <div className="mt-1 flex justify-end gap-2 text-sm">
                        <button
                            type="button"
                            data-testid="message-delete-cancel"
                            onClick={() => setConfirmingDelete(false)}
                            className="rounded px-2 py-0.5 hover:bg-accent"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            data-testid="message-delete-confirm"
                            onClick={() => {
                                close();
                                onDelete();
                            }}
                            className="rounded bg-destructive px-2 py-0.5 text-destructive-foreground hover:bg-destructive/90"
                        >
                            Delete
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
