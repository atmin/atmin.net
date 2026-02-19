interface Props {
    text: string;
    timestamp: Date;
    sent: boolean;
}

export default function ChatMessage({ text, timestamp, sent }: Props) {
    return (
        <div
            data-testid="message"
            className={`rounded-2xl border border-border p-3 ${
                sent ? 'ml-8 rounded-tr-none' : 'mr-8 rounded-tl-none'
            }`}
        >
            <p className="text-sm">{text}</p>
            <p className="mt-1 text-xs text-muted-foreground">
                {timestamp.getTime() === 0
                    ? 'No timestamp'
                    : timestamp.toLocaleTimeString()}
            </p>
        </div>
    );
}
