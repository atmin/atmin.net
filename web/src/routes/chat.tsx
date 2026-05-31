import { useEffect, useMemo } from 'react';
import ChatView from '@/components/ChatView';
import { useChat } from '@/hooks/useChat';
import { useChatAmendments } from '@/hooks/useChatAmendments';
import { useChatScroll } from '@/hooks/useChatScroll';
import { useMedia } from '@/hooks/useMedia';
import type { Session } from '@/lib/auth';
import type { MediaFile } from '@/lib/media';
import type { SessionManager } from '@/lib/megolm-session';

interface Props {
    handle: string;
    session: Session;
    sessionManager: SessionManager | null;
    onSendingChange?: (sending: boolean) => void;
}

export default function ChatRoute({
    handle,
    session,
    sessionManager,
    onSendingChange,
}: Props) {
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

    const { editMessage, deleteMessage } = useChatAmendments(
        handle,
        handle === 'saved',
        session,
        sessionManager,
    );

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

    const scroll = useChatScroll(messages, handle);

    return (
        <ChatView
            chatTitle={chatTitle}
            isSaved={handle === 'saved'}
            handle={handle}
            messages={messages}
            loading={loading}
            sending={sending}
            online={online}
            encryptionReady={encryptionReady}
            mediaStates={mediaStates}
            onMediaRetry={onMediaRetry}
            onSend={sendMessage}
            onSendMedia={sendMedia}
            onEditMessage={editMessage}
            onDeleteMessage={deleteMessage}
            scrollContainerRef={scroll.setScrollEl}
            showJumpToBottom={scroll.showJumpToBottom}
            onJumpToBottom={scroll.jumpToBottom}
        />
    );
}
