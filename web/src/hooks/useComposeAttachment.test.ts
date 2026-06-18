// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useComposeAttachment } from './useComposeAttachment';

// The hook owns the thumbnail object-URL lifecycle, so the assertions are about
// when createObjectURL / revokeObjectURL fire. happy-dom may not implement them;
// assign vi.fns directly and restore the originals afterwards.
const origCreate = URL.createObjectURL;
const origRevoke = URL.revokeObjectURL;

function imageFile(name = 'shot.png'): File {
    return new File(['img-bytes'], name, { type: 'image/png' });
}

describe('useComposeAttachment', () => {
    let urlCounter: number;

    beforeEach(() => {
        urlCounter = 0;
        URL.createObjectURL = vi.fn(() => `blob:mock-${++urlCounter}`);
        URL.revokeObjectURL = vi.fn();
    });

    afterEach(() => {
        URL.createObjectURL = origCreate;
        URL.revokeObjectURL = origRevoke;
    });

    it('starts with no pending attachment', () => {
        const { result } = renderHook(() => useComposeAttachment());
        expect(result.current.pending).toBeNull();
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it('attach creates a preview URL for an image', () => {
        const { result } = renderHook(() => useComposeAttachment());
        const file = imageFile();
        act(() => result.current.attach(file));

        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
        expect(URL.createObjectURL).toHaveBeenCalledWith(file);
        expect(result.current.pending).toEqual({
            file,
            previewUrl: 'blob:mock-1',
            isImage: true,
        });
    });

    it('clear revokes the preview URL and drops the pending item', () => {
        const { result } = renderHook(() => useComposeAttachment());
        act(() => result.current.attach(imageFile()));
        act(() => result.current.clear());

        expect(result.current.pending).toBeNull();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
    });

    it('replacing revokes the previous URL and creates a new one', () => {
        const { result } = renderHook(() => useComposeAttachment());
        act(() => result.current.attach(imageFile('a.png')));
        act(() => result.current.attach(imageFile('b.png')));

        expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
        expect(result.current.pending?.previewUrl).toBe('blob:mock-2');
    });

    it('revokes the preview URL on unmount', () => {
        const { result, unmount } = renderHook(() => useComposeAttachment());
        act(() => result.current.attach(imageFile()));
        unmount();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
    });

    it('a non-image stages as a chip with no object URL', () => {
        const { result } = renderHook(() => useComposeAttachment());
        const file = new File(['data'], 'report.pdf', {
            type: 'application/pdf',
        });
        act(() => result.current.attach(file));

        expect(URL.createObjectURL).not.toHaveBeenCalled();
        expect(result.current.pending).toEqual({
            file,
            previewUrl: '',
            isImage: false,
        });

        // Clearing a chip revokes nothing (there is no URL to revoke).
        act(() => result.current.clear());
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    });
});
