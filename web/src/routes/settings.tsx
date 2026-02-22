import DeviceSettings from '@/components/DeviceSettings';
import ProfileSettings from '@/components/ProfileSettings';
import { useDevices } from '@/hooks/useDevices';
import type { Session } from '@/lib/auth';

interface Props {
    session: Session;
}

export default function SettingsRoute({ session }: Props) {
    const devicesState = useDevices(session.token, session.userId);

    return (
        <ProfileSettings handle={session.handle} token={session.token}>
            <DeviceSettings
                devices={devicesState.devices}
                currentDeviceId={session.deviceId}
                loading={devicesState.loading}
                error={devicesState.error}
                revoking={devicesState.revoking}
                mnemonicInput={devicesState.mnemonicInput}
                revokeError={devicesState.revokeError}
                onStartRevoke={devicesState.setRevoking}
                onCancelRevoke={() => devicesState.setRevoking(null)}
                onMnemonicChange={devicesState.setMnemonicInput}
                onConfirmRevoke={devicesState.handleRevoke}
            />
        </ProfileSettings>
    );
}
