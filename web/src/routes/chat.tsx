import { useParams } from 'react-router-dom';
import ChatView from '@/components/ChatView';
import { useChat } from '@/hooks/useChat';
import type { Session } from '@/lib/auth';
import type { SessionManager } from '@/lib/megolm-session';

interface Props {
    session: Session;
    sessionManager: SessionManager | null;
}

export default function ChatRoute({ session, sessionManager }: Props) {
    const { handle } = useParams<{ handle: string }>();
    const {
        messages,
        loading,
        sending,
        encryptionReady,
        chatTitle,
        sendMessage,
    } = useChat(handle, session, sessionManager);

    return (
        <ChatView
            chatTitle={chatTitle}
            isSaved={handle === 'saved'}
            handle={handle ?? ''}
            messages={messages}
            loading={loading}
            sending={sending}
            encryptionReady={encryptionReady}
            onSend={sendMessage}
        />
    );
}
