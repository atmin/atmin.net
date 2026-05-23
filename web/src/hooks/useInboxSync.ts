import { useEffect } from 'react';
import type { Session } from '@/lib/auth';
import { syncAndPublish } from '@/lib/inbox-sync';
import type { SessionManager } from '@/lib/megolm-session';
import { useOnlineStatus } from './useOnlineStatus';

export function useInboxSync(
    session: Session | null,
    sessionManager: SessionManager | null,
): void {
    const online = useOnlineStatus();

    useEffect(() => {
        if (!session || !sessionManager || !online) return;

        const s = session;
        const sm = sessionManager;

        syncAndPublish(s, sm);

        const url = `/v1/events?token=${encodeURIComponent(s.token)}`;
        const events = new EventSource(url);

        events.addEventListener('new_message', () => {
            syncAndPublish(s, sm);
        });

        events.onerror = () => {
            events.close();
        };

        return () => events.close();
    }, [session, sessionManager, online]);
}
