import { useEffect, useRef } from 'react';

// Konsta's Messagebar renders a fixed-height (h-10/h-12), resize-none textarea —
// it doesn't grow with multi-line input. Drive autogrow ourselves: on every value
// change reset the height, then clamp to the content's scroll height (capped, so a
// long paste scrolls internally rather than eating the screen). The inline height
// overrides Konsta's height class. Konsta owns the textarea ref, so we reach it by
// its id. Lives in a hook because it's a DOM side-effect (components/ can't
// useEffect) and is route-wired like the draft.
const MAX_HEIGHT_PX = 120;

// `value` is a dependency, not read directly: the textarea is controlled, so the
// effect must re-run on every value change (typed draft OR a message loaded for
// editing) to re-measure and resize. Reading the live element by id keeps us off
// Konsta's internal ref.
export function useAutogrowTextarea(textareaId: string, value: string): void {
    // Konsta's resting height (h-10 ios / h-12 material), captured once before we
    // start overriding it — single-line drafts floor here rather than shrinking
    // below Konsta's (deliberately roomy) input height.
    const baseRef = useRef<number | null>(null);
    // `value` is a re-run trigger, not read in the body: the textarea is
    // controlled, so the effect must re-measure the DOM element on each value
    // change. Dropping it would make autogrow mount-only.
    // biome-ignore lint/correctness/useExhaustiveDependencies: value is an intentional re-run trigger (read off the DOM, not the closure)
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
    }, [textareaId, value]);
}
