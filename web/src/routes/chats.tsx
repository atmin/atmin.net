import ChatsViewKonsta from '@/components/ChatsViewKonsta';
import { useConversations } from '@/hooks/useConversations';
import { useKonstaTheme } from '@/hooks/useKonstaTheme';
import { useViewTransitionNavigate } from '@/hooks/useViewTransitionNavigate';
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
    const { theme, setTheme } = useKonstaTheme();
    // Q4: drive the View Transitions API ourselves — RR's built-in option
    // no-ops under the declarative <BrowserRouter>. index.css styles the slide.
    const vtNavigate = useViewTransitionNavigate();

    return (
        <ChatsViewKonsta
            handle={session.handle}
            serverOk={serverOk}
            conversations={conversations}
            contacts={contacts}
            displayNames={displayNames}
            userId={session.userId}
            theme={theme}
            setTheme={setTheme}
            onOpen={vtNavigate}
            onNewChat={(handle) =>
                vtNavigate(
                    `/@${encodeURIComponent(handle.trim().toLowerCase())}`,
                )
            }
            onLogout={onLogout}
        />
    );
}
