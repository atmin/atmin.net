import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router-dom';

// Konsta spike (Q4). React Router's built-in `viewTransition` navigation option
// only works with the *data* router (createBrowserRouter/RouterProvider); this
// app uses the declarative <BrowserRouter>, which never runs that machinery — so
// the option is silently ignored. Drive the View Transitions API ourselves
// instead (router-agnostic, keeps the declarative router).
//
// flushSync forces React to commit the route change *synchronously* inside
// startViewTransition's capture callback, so the API snapshots the old DOM,
// applies the new route, then animates old→new. Without it the callback returns
// before React re-renders and nothing transitions.
export function useViewTransitionNavigate(): (path: string) => void {
    const navigate = useNavigate();
    return (path: string) => {
        const reduce =
            typeof matchMedia === 'function' &&
            matchMedia('(prefers-reduced-motion: reduce)').matches;
        const doc = document as Document & {
            startViewTransition?: (cb: () => void) => unknown;
        };
        if (!doc.startViewTransition || reduce) {
            navigate(path);
            return;
        }
        doc.startViewTransition(() => {
            flushSync(() => navigate(path));
        });
    };
}
