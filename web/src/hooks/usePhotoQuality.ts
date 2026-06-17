import { useState } from 'react';
import {
    getPhotoQuality,
    type PhotoQuality,
    setPhotoQuality,
} from '@/lib/photo-quality';

// useState-backed wrapper over the persisted photo-quality preference, mirroring
// useDraft's [value, setValue] shape. The Settings panel uses this; useChatSend
// reads the raw getPhotoQuality() at send time instead (no subscription needed
// on the send path).
export function usePhotoQuality(): [PhotoQuality, (q: PhotoQuality) => void] {
    const [value, setValueState] = useState<PhotoQuality>(getPhotoQuality);

    const setValue = (q: PhotoQuality) => {
        setValueState(q);
        setPhotoQuality(q);
    };

    return [value, setValue];
}
