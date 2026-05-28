import { useEffect, useState } from 'react';
import { resolve } from '@/lib/api';
import { validateHandleShape } from '@/lib/handle-suggest';

export type AvailabilityStatus =
    | 'idle' // empty input
    | 'invalid' // fails client-side shape check
    | 'checking' // debounce window or in-flight request
    | 'available' // resolve returned 404
    | 'taken' // resolve returned 200 (live)
    | 'released' // resolve returned 410 (in cooldown)
    | 'error'; // network or unexpected error

export interface HandleAvailability {
    status: AvailabilityStatus;
    message: string;
    /** Set on `released` so the form can render "available on YYYY-MM-DD". */
    availableAt?: string;
}

const DEBOUNCE_MS = 300;

/**
 * Resolve a handle to availability state, debounced. The reserved-list
 * check is server-only — the client only enforces shape, so a reserved
 * handle round-trips and surfaces as `taken` (or whatever the server
 * decides to map it to on `POST /v1/register` later).
 */
export function useHandleAvailability(handle: string): HandleAvailability {
    const [state, setState] = useState<HandleAvailability>({
        status: 'idle',
        message: '',
    });

    useEffect(() => {
        const trimmed = handle.trim();
        if (trimmed === '') {
            setState({ status: 'idle', message: '' });
            return;
        }

        const shapeError = validateHandleShape(trimmed);
        if (shapeError) {
            setState({ status: 'invalid', message: shapeError });
            return;
        }

        // Optimistically render the "checking" state while the debounce
        // window runs out, so the user sees feedback immediately.
        setState({ status: 'checking', message: 'Checking…' });

        let cancelled = false;
        const timer = setTimeout(async () => {
            try {
                const res = await resolve(trimmed);
                if (cancelled) return;
                if (res.status === 'live') {
                    setState({
                        status: 'taken',
                        message: '✗ Taken.',
                    });
                } else if (res.status === 'released') {
                    const date = res.available_at
                        ? new Date(res.available_at).toISOString().slice(0, 10)
                        : 'soon';
                    setState({
                        status: 'released',
                        message: `✗ In cooldown until ${date}.`,
                        availableAt: res.available_at,
                    });
                } else {
                    setState({
                        status: 'available',
                        message: '✓ Available.',
                    });
                }
            } catch {
                if (cancelled) return;
                setState({
                    status: 'error',
                    message: 'Could not check availability.',
                });
            }
        }, DEBOUNCE_MS);

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [handle]);

    return state;
}
