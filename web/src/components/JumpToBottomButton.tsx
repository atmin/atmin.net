interface Props {
    onClick: () => void;
}

export function JumpToBottomButton({ onClick }: Props) {
    return (
        <button
            type="button"
            data-testid="jump-to-bottom"
            onClick={onClick}
            aria-label="Jump to latest message"
            className="absolute right-4 bottom-4 z-10 rounded-full border border-border bg-background p-2 text-foreground shadow-md hover:bg-accent"
        >
            <svg
                viewBox="0 0 24 24"
                className="h-4 w-4 stroke-current"
                fill="none"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
            >
                <title>Jump to latest</title>
                <path d="M6 9l6 6 6-6" />
            </svg>
        </button>
    );
}
