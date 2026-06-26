import ChatsView from '@/components/ChatsView';
import { useConversations } from '@/hooks/useConversations';
import { useDrafts } from '@/hooks/useDrafts';
import { useViewTransitionNavigate } from '@/hooks/useViewTransitionNavigate';
import type { Session } from '@/lib/auth';

interface Props {
    session: Session;
}

export default function ChatsRoute({ session }: Props) {
    const { conversations, contacts, displayNames, serverOk, hydrated } =
        useConversations(session);
    const drafts = useDrafts();
    // Drive forward View Transitions for list → chat / settings (ADR-0023).
    const onOpen = useViewTransitionNavigate();

    return (
        <ChatsView
            serverOk={serverOk}
            conversations={conversations}
            contacts={contacts}
            displayNames={displayNames}
            drafts={drafts}
            userId={session.userId}
            hydrated={hydrated}
            onOpen={onOpen}
            onNewChat={(handle) =>
                onOpen(`/@${encodeURIComponent(handle.trim().toLowerCase())}`)
            }
        />
    );
}
