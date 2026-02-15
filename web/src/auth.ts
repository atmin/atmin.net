import { deleteDatabase, getKey, putKey } from './db';

export interface Session {
    token: string;
    userId: string;
    deviceId: string;
    inviteHandle: string;
    sharingPrivateKey: CryptoKey;
    sharingPublicKeyBytes: Uint8Array;
    backupKey: CryptoKey;
}

const LS_PREFIX = 'atmin:';

export async function saveSession(session: Session): Promise<void> {
    localStorage.setItem(`${LS_PREFIX}token`, session.token);
    localStorage.setItem(`${LS_PREFIX}userId`, session.userId);
    localStorage.setItem(`${LS_PREFIX}deviceId`, session.deviceId);
    localStorage.setItem(`${LS_PREFIX}inviteHandle`, session.inviteHandle);
    localStorage.setItem(
        `${LS_PREFIX}sharingPublicKeyBytes`,
        btoa(String.fromCharCode(...session.sharingPublicKeyBytes)),
    );

    await putKey('sharingPrivateKey', session.sharingPrivateKey);
    await putKey('backupKey', session.backupKey);
}

export async function loadSession(): Promise<Session | null> {
    const token = localStorage.getItem(`${LS_PREFIX}token`);
    const userId = localStorage.getItem(`${LS_PREFIX}userId`);
    const deviceId = localStorage.getItem(`${LS_PREFIX}deviceId`);
    const inviteHandle = localStorage.getItem(`${LS_PREFIX}inviteHandle`);
    const sharingPublicKeyBytesB64 = localStorage.getItem(
        `${LS_PREFIX}sharingPublicKeyBytes`,
    );

    if (
        !token ||
        !userId ||
        !deviceId ||
        !inviteHandle ||
        !sharingPublicKeyBytesB64
    )
        return null;

    const sharingPrivateKey = await getKey('sharingPrivateKey');
    const backupKey = await getKey('backupKey');

    if (!sharingPrivateKey || !backupKey) return null;

    const sharingPublicKeyBytes = new Uint8Array(
        atob(sharingPublicKeyBytesB64)
            .split('')
            .map((c) => c.charCodeAt(0)),
    );

    return {
        token,
        userId,
        deviceId,
        inviteHandle,
        sharingPrivateKey,
        sharingPublicKeyBytes,
        backupKey,
    };
}

export async function clearSession(): Promise<void> {
    localStorage.removeItem(`${LS_PREFIX}token`);
    localStorage.removeItem(`${LS_PREFIX}userId`);
    localStorage.removeItem(`${LS_PREFIX}deviceId`);
    localStorage.removeItem(`${LS_PREFIX}inviteHandle`);
    localStorage.removeItem(`${LS_PREFIX}sharingPublicKeyBytes`);
    await deleteDatabase();
}
