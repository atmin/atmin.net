import ChangePasswordPanel from '@/components/ChangePasswordPanel';
import DeviceSettings from '@/components/DeviceSettings';
import ProfileSettings from '@/components/ProfileSettings';
import { StorageIndicator } from '@/components/StorageIndicator';
import { useDevices } from '@/hooks/useDevices';
import { usePasswordStrength } from '@/hooks/usePasswordStrength';
import { useRotateKeys } from '@/hooks/useRotateKeys';
import { useStorageUsage } from '@/hooks/useStorageUsage';
import type { Session } from '@/lib/auth';

interface Props {
    session: Session;
    onSessionChange: (next: Session) => void;
}

export default function SettingsRoute({ session, onSessionChange }: Props) {
    const devicesState = useDevices(session.token, session.userId);
    const rotate = useRotateKeys(session, onSessionChange);
    const strength = usePasswordStrength(rotate.newPassword);
    const storage = useStorageUsage(session.token);

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
        </ProfileSettings>
    );
}
