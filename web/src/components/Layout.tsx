import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
    topBar?: ReactNode;
    children: ReactNode;
    className?: string;
    /** Lock to viewport height with a docked bottom area (chat view). */
    fullHeight?: boolean;
}

export default function Layout({
    topBar,
    children,
    className,
    fullHeight,
}: Props) {
    return (
        <div
            className={cn(
                'bg-background',
                fullHeight ? 'h-dvh overflow-hidden' : 'min-h-screen',
                className,
            )}
        >
            {topBar && (
                <header className="fixed top-0 right-0 left-0 z-10 border-b border-border bg-background/80 backdrop-blur-md">
                    <div className="mx-auto flex h-14 w-full max-w-2xl items-center px-4">
                        {topBar}
                    </div>
                </header>
            )}
            {fullHeight ? (
                <div className="flex h-full flex-col overflow-hidden">
                    {children}
                </div>
            ) : (
                children
            )}
        </div>
    );
}
