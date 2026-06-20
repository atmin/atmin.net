import { expect, test } from '@playwright/test';
import {
    E2E_PASSWORD,
    expectKonstaCheckboxChecked,
    openChat,
    registerUserWithPassword,
    tickKonstaCheckbox,
    waitForChatList,
} from './helpers';

const STRONG_PW = 'correct-horse-battery-staple-7';

// Each test in this file picks its own handle so cases don't collide on
// the per-handle uniqueness check (the helpers' default generator would
// hand back unique handles but we want the specific values to be visible
// in the assertions).
test.describe('Custom handles', () => {
    test('register with a chosen handle; taken on second attempt', async ({
        browser,
    }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        // Alice claims "alice-1" — picks it deliberately; the helper waits on
        // ✓ available, ticks the ack, and lands on the chat list.
        await registerUserWithPassword(alice, STRONG_PW, 'alice-1');

        // Bob tries the same handle — the availability indicator turns ✗.
        await bob.goto('/register');
        await bob.fill('#handle', 'alice-1');
        await expect(bob.getByTestId('handle-availability')).toHaveText(
            /Taken/,
            { timeout: 10_000 },
        );
        // The Register button must NOT be enabled while the handle is taken.
        const bobRegister = bob.getByRole('button', { name: 'Register' });
        await expect(bobRegister).toBeDisabled();

        await aliceCtx.close();
        await bobCtx.close();
    });

    test('reserved handle is rejected before any work', async ({ page }) => {
        await page.goto('/register');
        await page.fill('#handle', 'admin');
        // 'admin' is a valid shape, so the form will round-trip to the
        // server for availability — but registration would fail. The
        // availability indicator may say either "Available" (the resolve
        // endpoint just returns 404 for unregistered reserved handles)
        // or surface the server-side reservation on submit. We assert the
        // SUBMIT path: after pressing Register the server returns
        // 400 handle_reserved, the form surfaces a clear error.
        await expect(page.getByTestId('handle-availability')).toHaveText(
            /Available/,
            { timeout: 10_000 },
        );
        await page.fill('#password', STRONG_PW);
        await page.fill('#confirm', STRONG_PW);
        await tickKonstaCheckbox(page, 'register-ack');
        await expectKonstaCheckboxChecked(page, 'register-ack');
        const register = page.getByRole('button', { name: 'Register' });
        await expect(register).toBeEnabled({ timeout: 5_000 });
        await register.click();
        await expect(page.getByText(/reserved/i)).toBeVisible({
            timeout: 30_000,
        });
    });

    test('invalid handle shape shows inline error without server round-trip', async ({
        page,
    }) => {
        await page.goto('/register');
        // The form lowercases on input, so uppercase alone is not a useful
        // invalidity probe here — what we want is inputs that survive
        // lowercasing AND still fail the regex.
        for (const bad of ['al ice', '--bad', 'a', 'alice_test']) {
            await page.fill('#handle', bad);
            await expect(page.getByTestId('handle-availability')).toHaveText(
                /3.32|lowercase|consecutive/,
                { timeout: 5_000 },
            );
        }
    });

    test('Surprise me fills a valid random handle', async ({ page }) => {
        await page.goto('/register');
        await page.getByTestId('surprise-me').click();
        const filled = await page.inputValue('#handle');
        expect(filled).toMatch(/^[a-z]+-[a-z]+$/);
        await expect(page.getByTestId('handle-availability')).toHaveText(
            /Available/,
            { timeout: 10_000 },
        );
    });

    test('chat URL uses the /@ prefix; direct navigation works', async ({
        browser,
    }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const { handle: aliceHandle } = await registerUserWithPassword(
            alice,
            E2E_PASSWORD,
            'alice-url',
        );
        await registerUserWithPassword(bob, E2E_PASSWORD, 'bob-url');

        // Bob opens a chat with Alice via the Enter-a-handle input.
        await openChat(bob, aliceHandle);
        await expect(bob).toHaveURL(new RegExp(`/@${aliceHandle}$`));

        // Direct URL navigation (deep link) lands on the chat too.
        await bob.goto(`/@${aliceHandle}`);
        await expect(bob).toHaveURL(new RegExp(`/@${aliceHandle}$`));

        await aliceCtx.close();
        await bobCtx.close();
    });

    test('/saved still routes to Saved Messages (not 404, not the chat splat)', async ({
        page,
    }) => {
        await registerUserWithPassword(page, E2E_PASSWORD, 'saved-tester-1');
        await page.goto('/saved');
        // Saved Messages renders the chat composer — same component, just with
        // a self-conversation. The 404 element would render a "404" heading
        // instead, so the composer's presence is a sufficient probe. (Tag-agnostic:
        // the Konsta Messagebar is a textarea, not an input.)
        await expect(
            page.getByPlaceholder('Type a message...'),
        ).toBeVisible({ timeout: 15_000 });
    });

    test('/{handle} without the @ prefix is a 404 (no silent chat redirect)', async ({
        page,
    }) => {
        await registerUserWithPassword(page, E2E_PASSWORD, 'noat-tester-1');
        await page.goto('/some-other-handle');
        await expect(page.getByText('404')).toBeVisible({ timeout: 5_000 });
    });

    test('login normalises handle case and trims whitespace', async ({
        browser,
    }) => {
        const regCtx = await browser.newContext();
        const reg = await regCtx.newPage();
        const { handle, password } = await registerUserWithPassword(
            reg,
            E2E_PASSWORD,
            'casetest-x9',
        );

        const loginCtx = await browser.newContext();
        const login = await loginCtx.newPage();
        await login.goto('/login');
        // Type with surrounding whitespace + uppercase; the form lowercases
        // on input so the visible value matches what's submitted.
        await login.fill('#handle', '  CASETEST-X9  ');
        expect(await login.inputValue('#handle')).toBe('  casetest-x9  ');

        await login.fill('#secret', password);
        await login.getByRole('button', { name: 'Sign In' }).click();
        await waitForChatList(login);

        await regCtx.close();
        await loginCtx.close();
        // Avoid unused-var warning on handle.
        void handle;
    });
});
