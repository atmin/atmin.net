import { Block, Page } from 'konsta/react';

/**
 * Generic 404 element rendered when no route matches and the splat
 * fallback decides it's neither a `/@handle` chat nor `/saved`. A bare
 * centered Konsta Page (ADR-0023 / T5) — keeps the routes/ layer free of
 * styling per the architecture rules.
 */
export default function NotFound() {
    return (
        <Page className="flex items-center justify-center">
            <Block className="text-center">
                <p className="text-2xl font-medium">404</p>
                <p className="mt-2 text-sm opacity-60">Page not found.</p>
            </Block>
        </Page>
    );
}
