import { describe, expect, it } from 'vitest';
import { isAmendment, messagePreview, parseInner } from './payload';

describe('parseInner', () => {
    it('treats a legacy bare string as text', () => {
        expect(parseInner('hello world')).toEqual({
            kind: 'text',
            body: 'hello world',
        });
    });

    it('treats invalid JSON as text (verbatim)', () => {
        expect(parseInner('{not json')).toEqual({
            kind: 'text',
            body: '{not json',
        });
    });

    it('parses a typed text payload', () => {
        expect(
            parseInner(JSON.stringify({ type: 'text', body: 'hi' })),
        ).toEqual({ kind: 'text', body: 'hi' });
    });

    it('parses a media payload', () => {
        const file = {
            url: 'media/u/01',
            key: 'k',
            iv: 'iv',
            name: 'p.jpg',
            size: 5,
        };
        expect(
            parseInner(JSON.stringify({ type: 'media', body: 'cap', file })),
        ).toEqual({ kind: 'media', body: 'cap', file });
    });

    it('parses the additive optional file fields when present (ADR-0022)', () => {
        const file = {
            url: 'media/u/01',
            key: 'k',
            iv: 'iv',
            name: 'p.jpg',
            size: 5,
            mime: 'image/jpeg',
            width: 2048,
            height: 1536,
            optimized: true,
        };
        expect(
            parseInner(JSON.stringify({ type: 'media', body: 'cap', file })),
        ).toEqual({ kind: 'media', body: 'cap', file });
    });

    it('ignores additive fields of the wrong type, keeping the five-field core', () => {
        const file = {
            url: 'media/u/01',
            key: 'k',
            iv: 'iv',
            name: 'p.jpg',
            size: 5,
            mime: 42, // wrong type → dropped
            width: '2048', // wrong type → dropped
            optimized: 'yes', // wrong type → dropped
        };
        expect(
            parseInner(JSON.stringify({ type: 'media', body: 'cap', file })),
        ).toEqual({
            kind: 'media',
            body: 'cap',
            file: {
                url: 'media/u/01',
                key: 'k',
                iv: 'iv',
                name: 'p.jpg',
                size: 5,
            },
        });
    });

    it('parses the optional preview descriptor when well-formed (ADR-0022)', () => {
        const file = {
            url: 'media/u/full',
            key: 'k',
            iv: 'iv',
            name: 'p.jpg',
            size: 500_000,
            mime: 'image/jpeg',
            width: 2048,
            height: 1536,
            optimized: true,
            preview: {
                url: 'media/u/prev',
                key: 'pk',
                iv: 'piv',
                width: 320,
                height: 240,
            },
        };
        expect(
            parseInner(JSON.stringify({ type: 'media', body: 'cap', file })),
        ).toEqual({ kind: 'media', body: 'cap', file });
    });

    it('drops a malformed preview, keeping the rest of the file', () => {
        const file = {
            url: 'media/u/full',
            key: 'k',
            iv: 'iv',
            name: 'p.jpg',
            size: 5,
            preview: { url: 'media/u/prev', key: 'pk' }, // missing iv/width/height
        };
        const out = parseInner(
            JSON.stringify({ type: 'media', body: 'cap', file }),
        );
        expect(out).toEqual({
            kind: 'media',
            body: 'cap',
            file: {
                url: 'media/u/full',
                key: 'k',
                iv: 'iv',
                name: 'p.jpg',
                size: 5,
            },
        });
    });

    it('parses an amendment, carrying an unknown action through verbatim', () => {
        expect(
            parseInner(
                JSON.stringify({
                    type: 'amendment',
                    target_msg_id: '01T',
                    action: 'wat',
                }),
            ),
        ).toEqual({ kind: 'amendment', targetMsgId: '01T', action: 'wat' });
    });

    it('classifies an unknown top-level type as unknown (dropped, not text)', () => {
        expect(
            parseInner(JSON.stringify({ type: 'reaction', emoji: '👍' })),
        ).toEqual({ kind: 'unknown' });
    });

    it('treats malformed media (missing file fields) as unknown', () => {
        expect(
            parseInner(JSON.stringify({ type: 'media', body: 'x', file: {} })),
        ).toEqual({ kind: 'unknown' });
    });

    it('isAmendment reflects the amendment classification', () => {
        expect(
            isAmendment(
                JSON.stringify({
                    type: 'amendment',
                    target_msg_id: '01T',
                    action: 'edit',
                    body: 'b',
                }),
            ),
        ).toBe(true);
        expect(isAmendment('plain')).toBe(false);
        expect(isAmendment(JSON.stringify({ type: 'text', body: 'b' }))).toBe(
            false,
        );
    });
});

describe('messagePreview', () => {
    it('returns the body of a typed text envelope (not the raw JSON)', () => {
        expect(
            messagePreview(JSON.stringify({ type: 'text', body: 'hi there' })),
        ).toBe('hi there');
    });

    it('collapses newlines and runs of whitespace to a single line', () => {
        expect(
            messagePreview(
                JSON.stringify({ type: 'text', body: 'line one\nline   two' }),
            ),
        ).toBe('line one line two');
    });

    it('passes a legacy bare string through as text', () => {
        expect(messagePreview('old plain message')).toBe('old plain message');
    });

    it('shows <photo> for image media (by mime)', () => {
        expect(
            messagePreview(
                JSON.stringify({
                    type: 'media',
                    body: 'beach.jpg',
                    file: {
                        url: 'media/x',
                        key: 'k',
                        iv: 'i',
                        name: 'beach.jpg',
                        size: 1,
                        mime: 'image/jpeg',
                    },
                }),
            ),
        ).toBe('<photo>');
    });

    it('shows <photo> for a legacy image (no mime, image extension)', () => {
        expect(
            messagePreview(
                JSON.stringify({
                    type: 'media',
                    body: 'sunset.png',
                    file: {
                        url: 'media/x',
                        key: 'k',
                        iv: 'i',
                        name: 'sunset.png',
                        size: 1,
                    },
                }),
            ),
        ).toBe('<photo>');
    });

    it('shows <file> for a non-image attachment', () => {
        expect(
            messagePreview(
                JSON.stringify({
                    type: 'media',
                    body: 'report.pdf',
                    file: {
                        url: 'media/x',
                        key: 'k',
                        iv: 'i',
                        name: 'report.pdf',
                        size: 1,
                        mime: 'application/pdf',
                    },
                }),
            ),
        ).toBe('<file>');
    });

    it('returns empty for amendments and unknown types', () => {
        expect(
            messagePreview(
                JSON.stringify({
                    type: 'amendment',
                    target_msg_id: '01T',
                    action: 'edit',
                    body: 'b',
                }),
            ),
        ).toBe('');
        expect(messagePreview(JSON.stringify({ type: 'reaction' }))).toBe('');
    });
});
