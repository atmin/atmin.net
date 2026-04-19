import { expect, test } from '@playwright/test';
import { openChat, registerUser, sendMessage } from './helpers';

test.describe('Sync deduplication', () => {
    test('sending a message fires at most 2 compact calls', async ({
        browser,
    }) => {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();

        await registerUser(page);

        // Navigate to Saved Messages (self-chat — only one inbox involved)
        await openChat(page, 'saved');

        // Wait for the initial sync to finish. When loading flips false and
        // there are no messages yet, ChatView renders "No messages yet".
        // waitForLoadState('networkidle') never settles because the SSE
        // EventSource is a persistent connection.
        await page.waitForSelector('text=No messages yet', { timeout: 15_000 });

        // The compact count is the reliable regression signal for the dedup fix.
        //
        // Before the fix: sendMessage's explicit refetch and the SSE new_message
        // handler fired fetchMessages concurrently. Each sync fires 2 compacts
        // (one for the live inbox, one for key backups) = 4 total.
        //
        // After the fix: concurrent calls share one fetchMessages promise.
        // Any 2nd sequential sync (e.g. from a later SSE event) uses the cursor
        // saved by the first sync, gets 0 new items, and skips compaction.
        // Result: exactly 2 compacts per send.
        let compactsReceived = 0;
        let resolveCompacts!: () => void;
        const allCompactsDone = new Promise<void>((r) => {
            resolveCompacts = r;
        });
        const compactCalls: string[] = [];

        page.on('request', (req) => {
            if (new URL(req.url()).pathname === '/v1/store/compact') {
                compactCalls.push(req.method());
            }
        });
        page.on('response', (res) => {
            if (new URL(res.url()).pathname === '/v1/store/compact') {
                compactsReceived++;
                if (compactsReceived >= 2) resolveCompacts();
            }
        });

        await sendMessage(page, 'dedup test');

        // sendMessage waits for the message to appear (first sync done), but
        // compacts are fire-and-forget — wait for both response events.
        await allCompactsDone;

        expect(compactCalls).toHaveLength(2);

        await ctx.close();
    });
});
