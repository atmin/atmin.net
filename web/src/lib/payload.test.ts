import { describe, expect, it } from 'vitest';
import { isAmendment, parseInner } from './payload';

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
