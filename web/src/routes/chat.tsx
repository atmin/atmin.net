import { useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import ChatView from '@/components/ChatView';
import { useChat } from '@/hooks/useChat';
import { useMedia } from '@/hooks/useMedia';
import type { Session } from '@/lib/auth';
import type { MediaFile } from '@/lib/media';
import type { SessionManager } from '@/lib/megolm-session';

interface Props {
    session: Session;
    sessionManager: SessionManager | null;
    onSendingChange?: (sending: boolean) => void;
}

export default function ChatRoute({
    session,
    sessionManager,
    onSendingChange,
}: Props) {
    const { handle } = useParams<{ handle: string }>();
    const {
        messages,
        loading,
        sending,
        online,
        encryptionReady,
        chatTitle,
        sendMessage,
        sendMedia,
    } = useChat(handle, session, sessionManager);

    useEffect(() => {
        onSendingChange?.(sending);
    }, [sending, onSendingChange]);

    const mediaFiles = useMemo<MediaFile[]>(
        () => messages.flatMap((m) => (m.media ? [m.media] : [])),
        [messages],
    );
    const { states: mediaStates, retry: onMediaRetry } = useMedia(
        mediaFiles,
        session.token,
    );

    return (
        <ChatView
            chatTitle={chatTitle}
            isSaved={handle === 'saved'}
            handle={handle ?? ''}
            messages={messages}
            loading={loading}
            sending={sending}
            online={online}
            encryptionReady={encryptionReady}
            mediaStates={mediaStates}
            onMediaRetry={onMediaRetry}
            onSend={sendMessage}
            onSendMedia={sendMedia}
        />
    );
}
