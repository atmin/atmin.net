import { useNavigate } from 'react-router-dom';
import ChatsView from '@/components/ChatsView';
import { useConversations } from '@/hooks/useConversations';
import type { Session } from '@/lib/auth';
import type { SessionManager } from '@/lib/megolm-session';

interface Props {
    session: Session;
    sessionManager: SessionManager | null;
    onLogout: () => void;
}

export default function ChatsRoute({
    session,
    sessionManager,
    onLogout,
}: Props) {
    const { conversations, contacts, displayNames, serverOk } =
        useConversations(session, sessionManager);
    const navigate = useNavigate();

    return (
        <ChatsView
            handle={session.handle}
            serverOk={serverOk}
            conversations={conversations}
            contacts={contacts}
            displayNames={displayNames}
            userId={session.userId}
            onNewChat={(handle) => navigate(`/${encodeURIComponent(handle)}`)}
            onLogout={onLogout}
        />
    );
}
