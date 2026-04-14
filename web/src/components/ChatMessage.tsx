import type { MediaState } from '@/hooks/useMedia';
import type { MediaFile } from '@/lib/media';
import MediaAttachment from './MediaAttachment';

interface Props {
    text: string;
    timestamp: Date;
    sent: boolean;
    media?: MediaFile;
    mediaState?: MediaState;
    onMediaRetry?: (url: string) => void;
}

export default function ChatMessage({
    text,
    timestamp,
    sent,
    media,
    mediaState,
    onMediaRetry,
}: Props) {
    return (
        <div
            data-testid="message"
            className={`relative px-4 py-2.5 ${
                sent
                    ? 'ml-8 rounded-tl-2xl rounded-bl-2xl rounded-br-2xl bg-bubble-sent text-bubble-sent-foreground bubble-tail-sent'
                    : 'mr-8 rounded-tr-2xl rounded-bl-2xl rounded-br-2xl bg-bubble-received text-bubble-received-foreground bubble-tail-received'
            }`}
        >
            {media && mediaState && onMediaRetry && (
                <div className="mb-1">
                    <MediaAttachment
                        state={mediaState}
                        name={media.name}
                        size={media.size}
                        onRetry={() => onMediaRetry(media.url)}
                    />
                </div>
            )}
            {text && <p className="text-sm">{text}</p>}
            <p className="mt-1 text-xs opacity-50">
                {timestamp.getTime() === 0
                    ? 'No timestamp'
                    : timestamp.toLocaleTimeString()}
            </p>
        </div>
    );
}
