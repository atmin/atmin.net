/**
 * Generic 404 element rendered when no route matches and the splat
 * fallback decides it's neither a `/@handle` chat nor `/saved`. Keeps
 * the routes/ layer free of styling per the architecture rules.
 */
export default function NotFound() {
    return (
        <div className="flex min-h-screen items-center justify-center bg-background p-8">
            <div className="text-center">
                <p className="text-2xl font-medium">404</p>
                <p className="mt-2 text-sm text-muted-foreground">
                    Page not found.
                </p>
            </div>
        </div>
    );
}
