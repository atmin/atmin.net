import { useEffect } from 'react';
import { unreadCounts } from '@/lib/db';
import { onInboxUpdated } from '@/lib/inbox-sync';
import { onReadMarkersChanged } from '@/lib/read-markers';

// The Badging API isn't in the DOM lib types yet. Feature-detected before any
// use; a no-op everywhere it's unsupported (Firefox, or a non-installed tab).
type BadgeNavigator = Navigator & {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
};

/**
 * Mirror the count of conversations with ≥1 unread onto the installed-PWA app
 * icon (ADR-0026). Recomputes on inbox sync (new messages → badge up) and on
 * read-marker changes (open a chat → badge down), and clears when logged out
 * (userId null).
 *
 * "Fresh as of last open" by design: the badge can only change while our code
 * runs, so a buzz-while-closed refresh needs background delivery — deferred to
 * the native track (ADR-0015). Best-effort throughout; a Badging failure must
 * never break a render path.
 *
 * Platform note: this paints the home-screen icon on desktop Chrome/Edge and
 * Android. On an **installed iOS web app** `setAppBadge` exists (so the
 * feature-detect passes) but iOS gates it behind notification permission, which
 * we deliberately do not request (ADR-0015) — so the call is a silent no-op on
 * iOS. The in-app chats badge + "New" divider carry unread there. Decided to
 * leave the iOS icon badge unsupported for this milestone rather than prompt for
 * notifications; revisit with the native/notifications story.
 */
export function useAppBadge(userId: string | null): void {
    useEffect(() => {
        const nav = navigator as BadgeNavigator;
        if (!nav.setAppBadge) return;

        const update = async () => {
            try {
                if (!userId) {
                    await nav.clearAppBadge?.();
                    return;
                }
                // unreadCounts omits zero-unread conversations, so its size is
                // exactly the number of chats with something unread.
                const chats = (await unreadCounts(userId)).size;
                if (chats > 0) await nav.setAppBadge?.(chats);
                else await nav.clearAppBadge?.();
            } catch {
                // Badging is best-effort; swallow.
            }
        };

        update();
        const offInbox = onInboxUpdated(update);
        const offRead = onReadMarkersChanged(update);
        return () => {
            offInbox();
            offRead();
        };
    }, [userId]);
}
