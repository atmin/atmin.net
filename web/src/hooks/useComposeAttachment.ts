import { useEffect, useState } from 'react';

export interface PendingAttachment {
    // The staged file, sent verbatim at Send (the optimize/preview pipeline in
    // sendMedia runs on it then, exactly as it did on the picked file before).
    file: File;
    // Object URL for the tray thumbnail — only meaningful for images, '' for a
    // non-image (which renders as a name+size chip, no thumbnail). Owned by this
    // hook: created on attach, revoked on replace / clear / unmount.
    previewUrl: string;
    isImage: boolean;
}

export interface ComposeAttachment {
    pending: PendingAttachment | null;
    attach: (file: File) => void;
    clear: () => void;
}

// One pending compose attachment (P1d, ADR-0022). The picker, clipboard paste,
// and drag-drop all stage through `attach`; Send consumes `pending.file` then
// calls `clear`. Single-item only — attaching again replaces the current one
// (multi-select / albums are Phase 2).
//
// The object-URL lifecycle is why this is a hook, not component state: a blob
// URL leaks unless revoked, so we revoke the previous one on every change and
// on unmount. Creation happens in the `attach` handler (cheap, synchronous);
// the effect cleanup keyed on `previewUrl` does the revoking.
export function useComposeAttachment(): ComposeAttachment {
    const [pending, setPending] = useState<PendingAttachment | null>(null);

    useEffect(() => {
        const url = pending?.previewUrl;
        return () => {
            if (url) URL.revokeObjectURL(url);
        };
    }, [pending?.previewUrl]);

    const attach = (file: File) => {
        const isImage = file.type.startsWith('image/');
        // Only images get a thumbnail object URL; non-images show a chip.
        const previewUrl = isImage ? URL.createObjectURL(file) : '';
        setPending({ file, previewUrl, isImage });
    };

    const clear = () => setPending(null);

    return { pending, attach, clear };
}
