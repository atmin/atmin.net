import { deleteDatabase, getKey, putKey } from './db';

export interface Session {
    token: string;
    userId: string;
    deviceId: string;
    handle: string;
    sharingPrivateKey: CryptoKey;
    sharingPublicKeyBytes: Uint8Array;
    backupKey: CryptoKey;
    /**
     * Current `profile.key_version` for this account (ADR-0012). Stamped
     * onto new envelopes so the chain-aware reader can dispatch per-blob;
     * the change-password flow updates this in-place on success. Defaults
     * to 1 for sessions persisted before this field existed.
     */
    keyVersion: number;
}

const LS_PREFIX = 'atmin:';

export async function saveSession(session: Session): Promise<void> {
    localStorage.setItem(`${LS_PREFIX}token`, session.token);
    localStorage.setItem(`${LS_PREFIX}userId`, session.userId);
    localStorage.setItem(`${LS_PREFIX}deviceId`, session.deviceId);
    localStorage.setItem(`${LS_PREFIX}handle`, session.handle);
    localStorage.setItem(
        `${LS_PREFIX}sharingPublicKeyBytes`,
        btoa(String.fromCharCode(...session.sharingPublicKeyBytes)),
    );
    localStorage.setItem(`${LS_PREFIX}keyVersion`, String(session.keyVersion));

    await putKey('sharingPrivateKey', session.sharingPrivateKey);
    await putKey('backupKey', session.backupKey);
}

export async function loadSession(): Promise<Session | null> {
    const token = localStorage.getItem(`${LS_PREFIX}token`);
    const userId = localStorage.getItem(`${LS_PREFIX}userId`);
    const deviceId = localStorage.getItem(`${LS_PREFIX}deviceId`);
    const handle = localStorage.getItem(`${LS_PREFIX}handle`);
    const sharingPublicKeyBytesB64 = localStorage.getItem(
        `${LS_PREFIX}sharingPublicKeyBytes`,
    );

    if (!token || !userId || !deviceId || !handle || !sharingPublicKeyBytesB64)
        return null;

    const sharingPrivateKey = await getKey('sharingPrivateKey');
    const backupKey = await getKey('backupKey');

    if (!sharingPrivateKey || !backupKey) return null;

    const sharingPublicKeyBytes = new Uint8Array(
        atob(sharingPublicKeyBytesB64)
            .split('')
            .map((c) => c.charCodeAt(0)),
    );

    // Sessions written before ADR-0012 lacked keyVersion — default to 1.
    const kvRaw = localStorage.getItem(`${LS_PREFIX}keyVersion`);
    const keyVersion =
        kvRaw && Number.parseInt(kvRaw, 10) > 0
            ? Number.parseInt(kvRaw, 10)
            : 1;

    return {
        token,
        userId,
        deviceId,
        handle,
        sharingPrivateKey,
        sharingPublicKeyBytes,
        backupKey,
        keyVersion,
    };
}

export function clearToken(): void {
    localStorage.removeItem(`${LS_PREFIX}token`);
    localStorage.removeItem(`${LS_PREFIX}userId`);
    localStorage.removeItem(`${LS_PREFIX}deviceId`);
    localStorage.removeItem(`${LS_PREFIX}handle`);
    localStorage.removeItem(`${LS_PREFIX}sharingPublicKeyBytes`);
    localStorage.removeItem(`${LS_PREFIX}keyVersion`);
}

export async function clearSession(): Promise<void> {
    clearToken();
    await deleteDatabase();
}
