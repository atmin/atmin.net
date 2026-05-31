import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./messaging', () => ({
    sendInnerPayload: vi.fn().mockResolvedValue(undefined),
}));

import { sendAmendment } from './amendments';
import type { SessionManager } from './megolm-session';
import { sendInnerPayload } from './messaging';

const toPub = new Uint8Array([1]);
const selfPub = new Uint8Array([2]);
const mgr = {} as SessionManager;

async function callArgs() {
    return vi.mocked(sendInnerPayload).mock.calls[0];
}

describe('sendAmendment', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('sends an edit amendment carrying target_msg_id, action, and body inside the payload', async () => {
        await sendAmendment(
            'tok',
            'alice',
            'devA',
            'bob',
            toPub,
            selfPub,
            '01TARGET',
            'edit',
            'fixed typo',
            mgr,
        );

        const args = await callArgs();
        // The payload is the 7th positional argument to sendInnerPayload.
        expect(args[6]).toEqual({
            type: 'amendment',
            target_msg_id: '01TARGET',
            action: 'edit',
            body: 'fixed typo',
        });
    });

    it('omits body for a delete amendment', async () => {
        await sendAmendment(
            'tok',
            'alice',
            'devA',
            'bob',
            toPub,
            selfPub,
            '01TARGET',
            'delete',
            undefined,
            mgr,
        );

        const args = await callArgs();
        expect(args[6]).toEqual({
            type: 'amendment',
            target_msg_id: '01TARGET',
            action: 'delete',
        });
        expect(args[6]).not.toHaveProperty('body');
    });

    it('keeps target_msg_id out of the server-visible positional args (it rides inside the encrypted payload)', async () => {
        await sendAmendment(
            'tok',
            'alice',
            'devA',
            'bob',
            toPub,
            selfPub,
            '01SECRETTARGET',
            'delete',
            undefined,
            mgr,
        );

        const args = await callArgs();
        // Only the payload arg (index 6) may mention the target; the outer
        // routing args (token, from, device, to, keys) must not.
        const routingArgs = [args[0], args[1], args[2], args[3]];
        for (const a of routingArgs) {
            expect(String(a)).not.toContain('01SECRETTARGET');
        }
        expect(args[6]).toHaveProperty('target_msg_id', '01SECRETTARGET');
    });
});
