import {
    Actions,
    ActionsButton,
    ActionsGroup,
    ActionsLabel,
} from 'konsta/react';
import { useState } from 'react';

interface Props {
    // Whether the sheet is open (owned by ChatView, keyed to the active bubble).
    opened: boolean;
    // Edit is offered only when the active message is editable (text or
    // media-with-caption). False/omitted hides the Edit button (pure media).
    canEdit?: boolean;
    onEdit?: () => void;
    onDelete: () => void;
    onClose: () => void;
}

// Per-bubble action sheet for the user's own messages. A native-feel Konsta
// action sheet (it portals via fixed positioning, so ChatView mounts a single
// instance outside the transform-ed message bubbles). Delete is two-step —
// picking it swaps the sheet's groups for a confirm, since a delete propagates
// to every recipient and can't be undone. Pure presentational state only; the
// edit/delete effects live in useChatAmendments, wired through the route.
const DESTRUCTIVE = { textIos: 'text-red-500', textMaterial: 'text-red-500' };

// Konsta's iOS ActionsGroup ships no background (bgIos: ''), and the frosted
// `glass` style was trimmed from our theme (T0), so the default sheet rendered
// near-invisible. Give the group the standard iOS frosted surface explicitly;
// Material already has its surface-3 background.
const GROUP_COLORS = {
    bgIos: 'bg-white/80 backdrop-blur-xl dark:bg-[#1c1c1e]/80',
};

export default function MessageActions({
    opened,
    canEdit,
    onEdit,
    onDelete,
    onClose,
}: Props) {
    const [confirmingDelete, setConfirmingDelete] = useState(false);

    // Reset the confirm step whenever the sheet leaves the screen, so the next
    // open starts on the Edit/Delete group — done in the close handler since the
    // components layer forbids lifecycle effects.
    const close = () => {
        setConfirmingDelete(false);
        onClose();
    };

    return (
        <Actions opened={opened} onBackdropClick={close}>
            {confirmingDelete ? (
                <>
                    <ActionsGroup
                        colors={GROUP_COLORS}
                        data-testid="message-delete-confirm-prompt"
                    >
                        <ActionsLabel>
                            Delete this message for everyone?
                        </ActionsLabel>
                        <ActionsButton
                            bold
                            colors={DESTRUCTIVE}
                            data-testid="message-delete-confirm"
                            onClick={() => {
                                setConfirmingDelete(false);
                                onDelete();
                            }}
                        >
                            Delete
                        </ActionsButton>
                    </ActionsGroup>
                    <ActionsGroup colors={GROUP_COLORS}>
                        <ActionsButton
                            bold
                            data-testid="message-delete-cancel"
                            onClick={() => setConfirmingDelete(false)}
                        >
                            Cancel
                        </ActionsButton>
                    </ActionsGroup>
                </>
            ) : (
                <>
                    <ActionsGroup colors={GROUP_COLORS}>
                        {canEdit && (
                            <ActionsButton
                                data-testid="message-action-edit"
                                onClick={() => {
                                    setConfirmingDelete(false);
                                    onEdit?.();
                                }}
                            >
                                Edit
                            </ActionsButton>
                        )}
                        <ActionsButton
                            colors={DESTRUCTIVE}
                            data-testid="message-action-delete"
                            onClick={() => setConfirmingDelete(true)}
                        >
                            Delete
                        </ActionsButton>
                    </ActionsGroup>
                    <ActionsGroup colors={GROUP_COLORS}>
                        <ActionsButton bold onClick={close}>
                            Cancel
                        </ActionsButton>
                    </ActionsGroup>
                </>
            )}
        </Actions>
    );
}
