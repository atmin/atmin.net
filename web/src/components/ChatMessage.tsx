interface Props {
    text: string;
    timestamp: Date;
    sent: boolean;
}

export default function ChatMessage({ text, timestamp, sent }: Props) {
    return (
        <div
            data-testid="message"
            className={`relative px-4 py-2.5 ${
                sent
                    ? 'ml-8 rounded-tl-2xl rounded-bl-2xl rounded-br-2xl bg-bubble-sent text-bubble-sent-foreground bubble-tail-sent'
                    : 'mr-8 rounded-tr-2xl rounded-bl-2xl rounded-br-2xl bg-bubble-received text-bubble-received-foreground bubble-tail-received'
            }`}
        >
            <p className="text-sm">{text}</p>
            <p className="mt-1 text-xs opacity-50">
                {timestamp.getTime() === 0
                    ? 'No timestamp'
                    : timestamp.toLocaleTimeString()}
            </p>
        </div>
    );
}
