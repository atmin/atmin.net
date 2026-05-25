// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Message } from './useChat';
import { useChatScroll } from './useChatScroll';

interface FakeEl {
    el: HTMLDivElement;
    setScrollHeight: (n: number) => void;
}

// happy-dom returns 0 for layout properties; we stub them so the hook's
// at-bottom maths can be exercised.
function makeScrollEl(initialScrollHeight = 1000, clientHeight = 400): FakeEl {
    const el = document.createElement('div');
    let scrollHeight = initialScrollHeight;
    let scrollTop = 0;
    Object.defineProperty(el, 'scrollHeight', {
        get: () => scrollHeight,
        configurable: true,
    });
    Object.defineProperty(el, 'clientHeight', {
        get: () => clientHeight,
        configurable: true,
    });
    Object.defineProperty(el, 'scrollTop', {
        get: () => scrollTop,
        set: (v: number) => {
            scrollTop = v;
        },
        configurable: true,
    });
    return {
        el,
        setScrollHeight: (n) => {
            scrollHeight = n;
        },
    };
}

function msg(id: string, sent = false): Message {
    return { id, text: `msg ${id}`, timestamp: new Date(0), sent };
}

function render(initialMessages: Message[], initialHandle = 'alice') {
    return renderHook(
        ({ messages, handle }: { messages: Message[]; handle: string }) =>
            useChatScroll(messages, handle),
        { initialProps: { messages: initialMessages, handle: initialHandle } },
    );
}

describe('useChatScroll', () => {
    it('jumps to bottom when messages first appear after attach', () => {
        const { result, rerender } = render([]);
        const { el } = makeScrollEl(1000, 400);
        act(() => result.current.setScrollEl(el));

        // Simulate the typical empty → loaded transition driven by useChat.
        act(() =>
            rerender({
                messages: [msg('1'), msg('2'), msg('3')],
                handle: 'alice',
            }),
        );

        expect(el.scrollTop).toBe(1000);
        expect(result.current.showJumpToBottom).toBe(false);
    });

    it('does not scroll or show indicator on an empty list', () => {
        const { result } = render([]);
        const { el } = makeScrollEl(1000, 400);
        act(() => result.current.setScrollEl(el));

        expect(el.scrollTop).toBe(0);
        expect(result.current.showJumpToBottom).toBe(false);
    });

    it('auto-scrolls when a message arrives while at bottom', () => {
        const { result, rerender } = render([msg('1')]);
        const { el, setScrollHeight } = makeScrollEl(1000, 400);
        act(() => result.current.setScrollEl(el));
        // Seed last-id so the next render counts the next message as new.
        act(() => rerender({ messages: [msg('1')], handle: 'alice' }));
        // User is at bottom (default).

        setScrollHeight(1500);
        act(() =>
            rerender({ messages: [msg('1'), msg('2')], handle: 'alice' }),
        );

        expect(el.scrollTop).toBe(1500);
        expect(result.current.showJumpToBottom).toBe(false);
    });

    it('shows the indicator when a message arrives while scrolled up', () => {
        const { result, rerender } = render([msg('1')]);
        const { el } = makeScrollEl(1000, 400);
        act(() => result.current.setScrollEl(el));
        act(() => rerender({ messages: [msg('1')], handle: 'alice' }));

        // User scrolls up: bottom-distance = 1000 - 0 - 400 = 600 > 64.
        el.scrollTop = 0;
        act(() => el.dispatchEvent(new Event('scroll')));

        act(() =>
            rerender({ messages: [msg('1'), msg('2')], handle: 'alice' }),
        );

        expect(el.scrollTop).toBe(0);
        expect(result.current.showJumpToBottom).toBe(true);
    });

    it("always scrolls to bottom for the user's own send", () => {
        const { result, rerender } = render([msg('1')]);
        const { el, setScrollHeight } = makeScrollEl(1000, 400);
        act(() => result.current.setScrollEl(el));
        act(() => rerender({ messages: [msg('1')], handle: 'alice' }));

        // User is scrolled up reading history.
        el.scrollTop = 0;
        act(() => el.dispatchEvent(new Event('scroll')));

        setScrollHeight(1500);
        act(() =>
            rerender({
                messages: [msg('1'), msg('2', true)],
                handle: 'alice',
            }),
        );

        expect(el.scrollTop).toBe(1500);
        expect(result.current.showJumpToBottom).toBe(false);
    });

    it('resets indicator and at-bottom state when the handle changes', () => {
        const { result, rerender } = render([msg('1')]);
        const { el } = makeScrollEl(1000, 400);
        act(() => result.current.setScrollEl(el));
        act(() => rerender({ messages: [msg('1')], handle: 'alice' }));

        // Trigger the indicator on the first chat.
        el.scrollTop = 0;
        act(() => el.dispatchEvent(new Event('scroll')));
        act(() =>
            rerender({ messages: [msg('1'), msg('2')], handle: 'alice' }),
        );
        expect(result.current.showJumpToBottom).toBe(true);

        // Switch chats — indicator clears, at-bottom is reasserted.
        act(() => rerender({ messages: [msg('a1')], handle: 'bob' }));
        expect(result.current.showJumpToBottom).toBe(false);
        // New chat's messages then trigger a scroll-to-bottom.
        expect(el.scrollTop).toBe(1000);
    });

    it('jumpToBottom() scrolls and clears the indicator', () => {
        const { result, rerender } = render([msg('1')]);
        const { el, setScrollHeight } = makeScrollEl(1000, 400);
        act(() => result.current.setScrollEl(el));
        act(() => rerender({ messages: [msg('1')], handle: 'alice' }));

        el.scrollTop = 0;
        act(() => el.dispatchEvent(new Event('scroll')));
        act(() =>
            rerender({ messages: [msg('1'), msg('2')], handle: 'alice' }),
        );
        expect(result.current.showJumpToBottom).toBe(true);

        setScrollHeight(1500);
        act(() => result.current.jumpToBottom());

        expect(el.scrollTop).toBe(1500);
        expect(result.current.showJumpToBottom).toBe(false);
    });

    it('clears the indicator when the user scrolls back into the bottom zone', () => {
        const { result, rerender } = render([msg('1')]);
        const { el } = makeScrollEl(1000, 400);
        act(() => result.current.setScrollEl(el));
        act(() => rerender({ messages: [msg('1')], handle: 'alice' }));

        el.scrollTop = 0;
        act(() => el.dispatchEvent(new Event('scroll')));
        act(() =>
            rerender({ messages: [msg('1'), msg('2')], handle: 'alice' }),
        );
        expect(result.current.showJumpToBottom).toBe(true);

        // Within slack: 1000 - 580 - 400 = 20 < 64.
        el.scrollTop = 580;
        act(() => el.dispatchEvent(new Event('scroll')));

        expect(result.current.showJumpToBottom).toBe(false);
    });

    it('re-anchors to bottom on window resize while at bottom', () => {
        const { result, rerender } = render([msg('1')]);
        const { el, setScrollHeight } = makeScrollEl(1000, 400);
        act(() => result.current.setScrollEl(el));
        act(() => rerender({ messages: [msg('1')], handle: 'alice' }));

        // Mobile-keyboard-style layout shrink: scrollHeight bumps up,
        // scrollTop is left behind by the layout change.
        setScrollHeight(1800);
        el.scrollTop = 600;

        act(() => window.dispatchEvent(new Event('resize')));

        expect(el.scrollTop).toBe(1800);
    });
});
