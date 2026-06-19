import { useState } from 'react';

export type KonstaTheme = 'ios' | 'material';

// ADR-0023: "iOS feel on Apple platforms, Material everywhere else." On web we
// sniff the UA; in the native shells this is where `Capacitor.getPlatform()` /
// the Tauri OS plugin would feed in instead (those branches slot in when the
// shells land). The setter lets a screen flip the theme live — used by the
// Storybook harness and, later, any in-app theme override.
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
