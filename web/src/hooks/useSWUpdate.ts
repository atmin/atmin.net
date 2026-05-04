import { useRegisterSW } from 'virtual:pwa-register/react';
import { useEffect } from 'react';

export function useSWUpdate(sending: boolean) {
    const {
        needRefresh: [needRefresh, setNeedRefresh],
        updateServiceWorker,
    } = useRegisterSW();

    const hasDraft = Object.keys(localStorage).some((k) =>
        k.startsWith('atmin:draft:'),
    );

    useEffect(() => {
        if (needRefresh && !sending && !hasDraft) updateServiceWorker(true);
    }, [needRefresh, sending, hasDraft, updateServiceWorker]);

    return {
        needRefresh,
        onUpdate: () => updateServiceWorker(true),
        onDismiss: () => setNeedRefresh(false),
    };
}
