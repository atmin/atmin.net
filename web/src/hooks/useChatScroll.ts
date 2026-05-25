import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from './useChat';

const AT_BOTTOM_SLACK_PX = 64;

interface ScrollState {
    setScrollEl: (el: HTMLDivElement | null) => void;
    showJumpToBottom: boolean;
    jumpToBottom: () => void;
}

export function useChatScroll(
    messages: Message[],
    handle: string,
): ScrollState {
    const elRef = useRef<HTMLDivElement | null>(null);
    const atBottomRef = useRef(true);
    const lastMessageIdRef = useRef<string | null>(null);
    const prevHandleRef = useRef(handle);
    const [showJump, setShowJump] = useState(false);

    const scrollToBottom = useCallback(() => {
        const el = elRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        atBottomRef.current = true;
        setShowJump(false);
    }, []);

    useEffect(() => {
        // Conversation switch: a fresh chat always opens at its bottom and
        // any leftover "jump to latest" indicator from the previous chat
        // is dropped.
        if (prevHandleRef.current !== handle) {
            prevHandleRef.current = handle;
            atBottomRef.current = true;
            lastMessageIdRef.current = null;
            setShowJump(false);
        }

        const el = elRef.current;
        if (!el) return;
        const last = messages[messages.length - 1];
        const lastId = last?.id ?? null;
        const isNew = lastId !== null && lastId !== lastMessageIdRef.current;
        // The user's own send wins over a scrolled-up reading position —
        // they expect to see what they just sent.
        const newSelfSend = isNew && last?.sent === true;
        lastMessageIdRef.current = lastId;

        if (atBottomRef.current || newSelfSend) {
            scrollToBottom();
        } else if (isNew) {
            setShowJump(true);
        }
    }, [messages, handle, scrollToBottom]);

    useEffect(() => {
        const onResize = () => {
            if (atBottomRef.current) scrollToBottom();
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [scrollToBottom]);

    const setScrollEl = useCallback((el: HTMLDivElement | null) => {
        elRef.current = el;
        if (!el) return;
        const onScroll = () => {
            const atBottom =
                el.scrollHeight - el.scrollTop - el.clientHeight <
                AT_BOTTOM_SLACK_PX;
            atBottomRef.current = atBottom;
            if (atBottom) setShowJump(false);
        };
        el.addEventListener('scroll', onScroll);
    }, []);

    return {
        setScrollEl,
        showJumpToBottom: showJump,
        jumpToBottom: scrollToBottom,
    };
}
