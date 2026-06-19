import ChatsView from '@/components/ChatsView';
import { useConversations } from '@/hooks/useConversations';
import { useViewTransitionNavigate } from '@/hooks/useViewTransitionNavigate';
import type { Session } from '@/lib/auth';
import type { SessionManager } from '@/lib/megolm-session';

interface Props {
    session: Session;
    sessionManager: SessionManager | null;
}

export default function ChatsRoute({ session, sessionManager }: Props) {
    const { conversations, contacts, displayNames, serverOk } =
        useConversations(session, sessionManager);
    // Drive forward View Transitions for list → chat / settings (ADR-0023).
    const onOpen = useViewTransitionNavigate();

    return (
        <ChatsView
            serverOk={serverOk}
            conversations={conversations}
            contacts={contacts}
            displayNames={displayNames}
            userId={session.userId}
            onOpen={onOpen}
            onNewChat={(handle) =>
                onOpen(`/@${encodeURIComponent(handle.trim().toLowerCase())}`)
            }
        />
    );
}
