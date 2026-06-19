import { useState } from 'react';

export type KonstaTheme = 'ios' | 'material';

// "iOS feel on Apple platforms, Material everywhere else" (v0.2 UX direction).
// On web we sniff the UA; in the native shells this is where
// `Capacitor.getPlatform()` / the Tauri OS plugin would feed in instead. The
// spike also returns a setter so the theme can be flipped live to compare the
// two renderings side by side.
function detectApplePlatform(): boolean {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent;
    // iPhone/iPod/iPad (incl. iPadOS masquerading as macOS) or desktop macOS.
    return /iP(hone|ad|od)|Macintosh|Mac OS X/.test(ua);
}

export function useKonstaTheme(): {
    theme: KonstaTheme;
    setTheme: (t: KonstaTheme) => void;
} {
    const [theme, setTheme] = useState<KonstaTheme>(() =>
        detectApplePlatform() ? 'ios' : 'material',
    );
    return { theme, setTheme };
}
