# iOS install hint

## Motivation

On iOS Safari, "Add to Home Screen" lives inside the Share sheet — there is no
install prompt or address-bar icon like Android Chrome offers. First-time users
have no reason to look there, so the PWA installs fine but nobody discovers it.

A dismissible bottom banner pointing at the Share button is the lowest-effort
fix. iOS is the only platform that needs it (Android Chrome shows its own
install prompt; the Tauri desktop wrapper from ADR-0009 has no install path
needed).

## Current state

- No iOS hint logic exists.
- Existing bottom-of-viewport overlays at `z-50`:
  - [OfflineIndicator.tsx:5](../web/src/components/OfflineIndicator.tsx) — `bottom-4`
  - [SWUpdateToast.tsx:9](../web/src/components/SWUpdateToast.tsx) — `bottom-4`
- Both are wired in [routes/app.tsx:93-100](../web/src/routes/app.tsx).
- `localStorage`-based dismiss flags already follow the `atmin:` prefix
  (see `atmin:draft:*` keys).

## Architecture constraints

[lint-architecture.sh](../web/scripts/lint-architecture.sh):
- `components/` may not use `useEffect`/`useCallback`/`useMemo`/`useRef` and
  may not value-import from `@/hooks/`.
- `hooks/` files must be `.ts` (no JSX).

Therefore: detection + persistence in a hook, pure UI in a component, wiring in
the route. Same shape as `useSWUpdate` + `SWUpdateToast`.

## Detection rules

| Condition | Required for banner |
|---|---|
| Platform is iPhone / iPod (userAgent matches `/iP(hone\|od)/`) | ✓ |
| Browser is Safari (userAgent matches `Safari` and NOT `CriOS\|FxiOS\|OPiOS\|EdgiOS`) | ✓ |
| Not already installed (neither `navigator.standalone === true` NOR `matchMedia('(display-mode: standalone)').matches`) | ✓ |
| Not previously dismissed (`localStorage['atmin:ios-hint-dismissed']` is null) | ✓ |
| App is currently online and no pending SW update | ✓ (gate at route level) |

**iPad scoping.** Since iPadOS 13, iPad Safari reports `navigator.userAgent`
as macOS Safari (`Macintosh; …`). Reliable iPad detection requires
`navigator.maxTouchPoints > 1 && /Mac/.test(ua)`, but conflates with
touch-capable macOS users on Touch Bar Macs and external touch displays. For
v0.1, scope to iPhone/iPod only — iPad PWAs are a smaller surface and the
detection risk isn't worth the false positives. Document this in the hook so
a future change can revisit.

## Change

### 1. `web/src/hooks/useIosInstallHint.ts` — new hook

```ts
import { useEffect, useState } from 'react';

const DISMISSED_KEY = 'atmin:ios-hint-dismissed';
const SHOW_DELAY_MS = 3000; // skip first paint; landing page sits above the fold by then

// iPhone/iPod only — iPadOS 13+ Safari masquerades as macOS, and the
// touch-points fallback false-positives on touch-capable Macs.
function isIosSafari(ua: string): boolean {
    if (!/iP(hone|od)/.test(ua)) return false;
    if (/CriOS|FxiOS|OPiOS|EdgiOS/.test(ua)) return false;
    return /Safari/.test(ua);
}

function isStandalone(): boolean {
    // Legacy iOS-only flag (not in standard Navigator type)
    const legacy = (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const modern =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(display-mode: standalone)').matches;
    return legacy || modern;
}

export function useIosInstallHint() {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (!isIosSafari(navigator.userAgent)) return;
        if (isStandalone()) return;
        if (localStorage.getItem(DISMISSED_KEY)) return;

        const t = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
        return () => clearTimeout(t);
    }, []);

    function dismiss() {
        setVisible(false);
        localStorage.setItem(DISMISSED_KEY, '1');
    }

    return { visible, dismiss };
}
```

Notes:
- `isIosSafari` takes `ua` as a parameter so tests can pass synthetic UAs
  without `vi.spyOn` (cleaner than mocking the getter for one call).
- The Tauri desktop wrapper's userAgent does not match `/iP(hone|od)/`, so
  it's naturally excluded.

### 2. `web/src/hooks/useIosInstallHint.test.ts` — new unit tests

```ts
// @vitest-environment happy-dom
```

Pattern matches [useOnlineStatus.test.ts](../web/src/hooks/useOnlineStatus.test.ts).
Use `vi.useFakeTimers()` to drive the 3 s delay; `vi.spyOn(navigator, 'userAgent', 'get')`
to set platform; `Object.defineProperty(navigator, 'standalone', ...)` to
mock the legacy flag; `vi.stubGlobal('matchMedia', ...)` for the modern check.

Required cases (`beforeEach` clears localStorage + restores mocks):

| Test | Setup | Assert |
|---|---|---|
| iPhone Safari + not standalone + not dismissed → visible after 3 s | UA = iPhone Safari | `visible` is `false` at t=0, `true` after `vi.advanceTimersByTime(3000)` |
| Chrome on iOS (`CriOS`) | UA = iPhone CriOS | never visible after 3 s |
| Firefox on iOS (`FxiOS`) | UA = iPhone FxiOS | never visible after 3 s |
| Android Chrome | UA = Android Chrome | never visible |
| Desktop Safari | UA = Mac Safari | never visible (iPad masquerade is intentional cost) |
| Standalone (legacy flag) | UA = iPhone Safari, `navigator.standalone = true` | never visible |
| Standalone (matchMedia) | UA = iPhone Safari, `matchMedia('(display-mode: standalone)').matches = true` | never visible |
| Previously dismissed | UA = iPhone Safari, `localStorage.setItem('atmin:ios-hint-dismissed', '1')` | never visible |
| `dismiss()` hides and persists | mount → advance to visible → call `dismiss()` | `visible === false`, localStorage flag set |

### 3. `web/src/components/IosInstallHint.tsx` — new component

```tsx
interface Props {
    onDismiss: () => void;
}

export function IosInstallHint({ onDismiss }: Props) {
    return (
        <div
            data-testid="ios-install-hint"
            className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-lg border bg-background px-4 py-2 shadow-lg text-sm"
        >
            <span className="flex-1">
                To install: tap{' '}
                <span className="inline-flex items-center gap-0.5 font-medium">
                    {/* Approximation of Safari's Share glyph — square with up-arrow.
                        We don't ship Apple's official icon. */}
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
                aria-label="Dismiss install hint"
                className="shrink-0 text-muted-foreground hover:text-foreground"
            >
                ✕
            </button>
        </div>
    );
}
```

Positioning matches `OfflineIndicator` / `SWUpdateToast` (`bottom-4`,
centered) — gating in the route ensures only one is visible at a time.

### 4. `web/src/components/IosInstallHint.stories.tsx` — new Storybook story

Match the pattern in [OfflineIndicator.stories.tsx](../web/src/components/OfflineIndicator.stories.tsx):

```ts
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { IosInstallHint } from './IosInstallHint';

const meta = {
    title: 'App/IosInstallHint',
    component: IosInstallHint,
    args: { onDismiss: fn() },
} satisfies Meta<typeof IosInstallHint>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
```

Visual check both light and dark mode in Storybook before merge.

### 5. `web/src/routes/app.tsx` — wire it

```tsx
import { useIosInstallHint } from '@/hooks/useIosInstallHint';
import { IosInstallHint } from '@/components/IosInstallHint';

// inside App(), alongside useSWUpdate:
const iosHint = useIosInstallHint();

// in JSX, replacing the existing overlay block:
{iosHint.visible && online && !swUpdate.needRefresh && (
    <IosInstallHint onDismiss={iosHint.dismiss} />
)}
{swUpdate.needRefresh && (
    <SWUpdateToast
        sending={chatSending}
        onUpdate={swUpdate.onUpdate}
        onDismiss={swUpdate.onDismiss}
    />
)}
{!online && <OfflineIndicator />}
```

Gating rule: install hint hides while offline (more urgent message exists) or
while a SW update is pending (user is about to reload anyway). Only one
bottom overlay is visible at a time.

## Verify

- `make lint test` — passes; new `useIosInstallHint.test.ts` cases all pass.
- Storybook (`make web-storybook` on `:6006`) — `App/IosInstallHint` renders
  correctly in both light and dark mode.
- Open the deployed app in iPhone Safari (not installed). Wait 3 s — banner
  appears.
- Tap ✕ — banner disappears, does not reappear on reload
  (`atmin:ios-hint-dismissed` set).
- Follow the hint (Share → Add to Home Screen) → install works. Reopen the
  installed app: banner never appears (`isStandalone()` returns true).
- Open in desktop Chrome / Android Chrome / desktop Safari — banner never
  appears.
- Open in Chrome on iOS (`CriOS`) — banner never appears.
- Go offline before the 3 s timer fires → banner does not appear (route
  gates on `online`).
- Trigger a SW update before the 3 s timer fires → banner does not appear
  until the update is resolved.
- Clearing browser data wipes the dismiss flag → banner reappears on next
  visit. This is intentional (the user explicitly reset state); not a bug.

## Out of scope

- iPad support — scoped out as documented in the hook. Revisit if iPad PWA
  installs become a meaningful surface.
- A11y-driven dismiss (keyboard) — `<button>` already handles `Enter`/`Space`.
- Animation/transition on appear — keep it static; matches existing overlay
  components.
