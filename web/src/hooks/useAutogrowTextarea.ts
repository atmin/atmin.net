import { useEffect, useRef } from 'react';

// Konsta's Messagebar renders a fixed-height (h-10/h-12), resize-none textarea —
// it doesn't grow with multi-line input. Drive autogrow ourselves: on every value
// change reset the height, then clamp to the content's scroll height (capped, so a
// long paste scrolls internally rather than eating the screen). The inline height
// overrides Konsta's height class. Konsta owns the textarea ref, so we reach it by
// its id. Lives in a hook because it's a DOM side-effect (components/ can't
// useEffect) and is route-wired like the draft.
const MAX_HEIGHT_PX = 120;

export function useAutogrowTextarea(textareaId: string): void {
    // Konsta's resting height (h-10 ios / h-12 material), captured once before we
    // start overriding it — single-line drafts floor here rather than shrinking
    // below Konsta's (deliberately roomy) input height.
    const baseRef = useRef<number | null>(null);
    useEffect(() => {
        const el = document.getElementById(textareaId);
        if (!(el instanceof HTMLTextAreaElement)) return;
        if (baseRef.current === null) baseRef.current = el.offsetHeight;
        el.style.height = 'auto';
        const grown = Math.max(el.scrollHeight, baseRef.current);
        el.style.height = `${Math.min(grown, MAX_HEIGHT_PX)}px`;
        el.style.overflowY = grown > MAX_HEIGHT_PX ? 'auto' : 'hidden';
        // Controls center on a single line, bottom-align once the textarea grows
        // (iOS-Messages). The CSS default is center for the rest / no-JS case.
        const inner = el
            .closest('.k-toolbar')
            ?.querySelector('div.justify-between');
        if (inner instanceof HTMLElement) {
            inner.style.alignItems =
                grown > baseRef.current ? 'flex-end' : 'center';
        }
    }, [textareaId]);
}
