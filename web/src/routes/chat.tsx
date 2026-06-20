import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ChatView from '@/components/ChatView';
import { useAutogrowTextarea } from '@/hooks/useAutogrowTextarea';
import { useChat } from '@/hooks/useChat';
import { useChatAmendments } from '@/hooks/useChatAmendments';
import { useChatScroll } from '@/hooks/useChatScroll';
import { useComposeAttachment } from '@/hooks/useComposeAttachment';
import { useDraft } from '@/hooks/useDraft';
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
    const {
        states: mediaStates,
        observe: mediaObserve,
        request: onMediaRequest,
    } = useMedia(mediaFiles, session.token);

    const scroll = useChatScroll(messages, handle);
    const [inputValue, setInputValue] = useDraft(handle ?? '');
    const compose = useComposeAttachment();

    // Editing reuses the composer rather than an inline field: starting an edit
    // loads the message body into a separate edit buffer (so the in-progress
    // draft is preserved), and the composer commits it via editMessage. The
    // route owns this because it also owns the draft and the autogrow value.
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editValue, setEditValue] = useState('');
    const startEdit = (id: string, body: string) => {
        setEditingId(id);
        setEditValue(body);
    };
    const cancelEdit = () => {
        setEditingId(null);
        setEditValue('');
    };
    const commitEdit = () => {
        const body = editValue.trim();
        if (editingId && body) editMessage(editingId, body);
        cancelEdit();
    };

    // Whatever the composer currently shows — the edit buffer while editing,
    // else the persisted draft. Feeds autogrow so the textarea resizes to fit a
    // loaded multi-line message as well as live typing.
    const composerValue = editingId !== null ? editValue : inputValue;
    useAutogrowTextarea('message-input', composerValue);

    // Plain navigate for back — directional/reverse View Transitions are the
    // parked data-router task (ADR-0023), so no animation on the way back.
    const navigate = useNavigate();

    return (
        <ChatView
            chatTitle={chatTitle}
            isSaved={handle === 'saved'}
            handle={handle}
            onBack={() => navigate('/')}
            messages={messages}
            loading={loading}
            sending={sending}
            online={online}
            encryptionReady={encryptionReady}
            mediaStates={mediaStates}
            onMediaRequest={onMediaRequest}
            mediaObserve={mediaObserve}
            onSend={sendMessage}
            onSendMedia={sendMedia}
            pending={compose.pending}
            onAttach={compose.attach}
            onClearAttachment={compose.clear}
            inputValue={inputValue}
            setInputValue={setInputValue}
            editingId={editingId}
            editValue={editValue}
            onEditValueChange={setEditValue}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onCommitEdit={commitEdit}
            onDeleteMessage={deleteMessage}
            scrollContainerRef={scroll.setScrollEl}
            showJumpToBottom={scroll.showJumpToBottom}
            onJumpToBottom={scroll.jumpToBottom}
        />
    );
}
