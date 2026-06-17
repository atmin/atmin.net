import ChangePasswordPanel from '@/components/ChangePasswordPanel';
import DeleteAccountPanel from '@/components/DeleteAccountPanel';
import DeviceSettings from '@/components/DeviceSettings';
import PhotoQualitySetting from '@/components/PhotoQualitySetting';
import ProfileSettings from '@/components/ProfileSettings';
import { StorageIndicator } from '@/components/StorageIndicator';
import { useDeleteAccount } from '@/hooks/useDeleteAccount';
import { useDevices } from '@/hooks/useDevices';
import { usePasswordStrength } from '@/hooks/usePasswordStrength';
import { usePhotoQuality } from '@/hooks/usePhotoQuality';
import { useRotateKeys } from '@/hooks/useRotateKeys';
import { useStorageUsage } from '@/hooks/useStorageUsage';
import type { Session } from '@/lib/auth';

interface Props {
    session: Session;
    onSessionChange: (next: Session) => void;
    onDeleted: () => void | Promise<void>;
}

export default function SettingsRoute({
    session,
    onSessionChange,
    onDeleted,
}: Props) {
    const devicesState = useDevices(session.token, session.userId);
    const rotate = useRotateKeys(session, onSessionChange);
    const strength = usePasswordStrength(rotate.newPassword);
    const storage = useStorageUsage(session.token);
    const [photoQuality, setPhotoQuality] = usePhotoQuality();
    const del = useDeleteAccount(session, onDeleted);

    return (
        <ProfileSettings handle={session.handle} token={session.token}>
            <StorageIndicator usage={storage.usage} loading={storage.loading} />
            <ChangePasswordPanel
                step={rotate.step}
                currentPassword={rotate.currentPassword}
                newPassword={rotate.newPassword}
                confirmPassword={rotate.confirmPassword}
                acknowledged={rotate.acknowledged}
                error={rotate.error}
                strength={strength}
                onCurrentChange={rotate.setCurrent}
                onNewChange={rotate.setNew}
                onConfirmChange={rotate.setConfirm}
                onAcknowledgedChange={rotate.setAcknowledged}
                onSubmit={rotate.submit}
            />
            <DeviceSettings
                devices={devicesState.devices}
                currentDeviceId={session.deviceId}
                loading={devicesState.loading}
                error={devicesState.error}
                revoking={devicesState.revoking}
                secretInput={devicesState.secretInput}
                revokeError={devicesState.revokeError}
                onStartRevoke={devicesState.setRevoking}
                onCancelRevoke={() => devicesState.setRevoking(null)}
                onSecretChange={devicesState.setSecretInput}
                onConfirmRevoke={devicesState.handleRevoke}
            />
            <PhotoQualitySetting
                value={photoQuality}
                onChange={setPhotoQuality}
            />
            <DeleteAccountPanel
                handle={session.handle}
                step={del.step}
                password={del.password}
                handleConfirm={del.handleConfirm}
                acknowledged={del.acknowledged}
                error={del.error}
                onPasswordChange={del.setPassword}
                onHandleConfirmChange={del.setHandleConfirm}
                onAcknowledgedChange={del.setAcknowledged}
                onSubmit={del.submit}
            />
        </ProfileSettings>
    );
}
