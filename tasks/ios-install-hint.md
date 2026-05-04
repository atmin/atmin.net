# iOS install hint

## Problem

On iOS Safari, "Add to Home Screen" is buried in the Share sheet — there is
no install prompt or address-bar icon like Android Chrome. First-time users
have no reason to look there. The result: the app installs fine but nobody
discovers it.

## Approach

Show a one-time dismissible banner at the bottom of the screen that points
toward the Safari Share button and explains the two-tap flow. Only show it
to users who:

1. Are on iOS Safari (not Chrome/Firefox on iOS, not Android).
2. Have not already installed (not running in standalone mode).
3. Have not already dismissed the hint.

Show it after a short delay (3 s) so it does not interrupt the landing
experience, and never show it again once dismissed (localStorage flag).

## Architecture

Follow the project's layer rules:

- `web/src/hooks/useIosInstallHint.ts` — detection + persistence logic.
- `web/src/components/IosInstallHint.tsx` — pure UI, no hooks.
- `web/src/routes/app.tsx` — wire the hook result to the component.

## Change

### 1. `web/src/hooks/useIosInstallHint.ts`

```ts
import { useEffect, useState } from 'react';

const DISMISSED_KEY = 'atmin:ios-hint-dismissed';

function isIosSafari(): boolean {
    const ua = navigator.userAgent;
    return (
        /iP(hone|od|ad)/.test(ua) &&
        /Safari/.test(ua) &&
        !/CriOS|FxiOS|OPiOS/.test(ua)
    );
}

function isStandalone(): boolean {
    // navigator.standalone is iOS-only, not in standard TS lib
    return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function useIosInstallHint() {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (!isIosSafari() || isStandalone()) return;
        if (localStorage.getItem(DISMISSED_KEY)) return;

        const t = setTimeout(() => setVisible(true), 3000);
        return () => clearTimeout(t);
    }, []);

    function dismiss() {
        setVisible(false);
        localStorage.setItem(DISMISSED_KEY, '1');
    }

    return { visible, dismiss };
}
```

### 2. `web/src/components/IosInstallHint.tsx`

The banner sits at the bottom of the viewport, above the browser chrome.
A small upward-pointing arrow on the hint echoes the Share button icon.

```tsx
interface Props {
    onDismiss: () => void;
}

export function IosInstallHint({ onDismiss }: Props) {
    return (
        <div className="fixed bottom-6 inset-x-4 z-50 flex items-center gap-3 rounded-xl border bg-background px-4 py-3 shadow-lg text-sm">
            <span className="flex-1">
                To install: tap{' '}
                <span className="inline-flex items-center gap-0.5 font-medium">
                    {/* Share icon — matches Safari's Share button glyph */}
                    <svg
                        viewBox="0 0 24 24"
                        className="inline h-4 w-4 stroke-current"
                        fill="none"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                    >
                        <path d="M12 3v12M8 7l4-4 4 4" />
                        <path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5" />
                    </svg>
                    Share
                </span>
                {' '}then{' '}
                <span className="font-medium">Add to Home Screen</span>
            </span>
            <button
                type="button"
                onClick={onDismiss}
                aria-label="Dismiss"
                className="shrink-0 text-muted-foreground hover:text-foreground"
            >
                ✕
            </button>
        </div>
    );
}
```

### 3. `web/src/routes/app.tsx`

```tsx
import { useIosInstallHint } from '@/hooks/useIosInstallHint';
import { IosInstallHint } from '@/components/IosInstallHint';

// inside App():
const iosHint = useIosInstallHint();

// in JSX, alongside SWUpdateToast:
{iosHint.visible && <IosInstallHint onDismiss={iosHint.dismiss} />}
```

## Verify

- Open https://atmin.sshtun.nl in iOS Safari (not installed). Wait 3 s —
  banner appears.
- Tap ✕ — banner disappears and does not reappear on reload
  (`atmin:ios-hint-dismissed` present in localStorage).
- Follow the hint (Share → Add to Home Screen) — install works. Reopening
  the installed app: banner never appears (`standalone === true`).
- Open in desktop Chrome / Android Chrome — banner does not appear
  (`isIosSafari()` returns false).
- Open in Chrome on iOS (`CriOS`) — banner does not appear.

## No automated test

`navigator.userAgent` and `navigator.standalone` cannot be reliably spoofed
in the vitest/Playwright environment. Manual verification on a physical iOS
device is the only meaningful test path. A Storybook story for `IosInstallHint`
can cover the visual layout (the pure component renders correctly given
`onDismiss` prop) but adds little beyond what is visible in the Verify steps.
