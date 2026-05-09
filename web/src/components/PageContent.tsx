import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
    children: ReactNode;
    className?: string;
}

export default function PageContent({ children, className }: Props) {
    return (
        <div
            className={cn(
                'mx-auto max-w-2xl px-8 pb-8 pt-20 font-mono text-sm',
                className,
            )}
        >
            {children}
        </div>
    );
}
