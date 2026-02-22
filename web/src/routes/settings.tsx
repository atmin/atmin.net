import ProfileSettings from '@/components/ProfileSettings';
import type { Session } from '@/lib/auth';

interface Props {
    session: Session;
}

export default function SettingsRoute({ session }: Props) {
    return (
        <ProfileSettings
            inviteHandle={session.inviteHandle}
            token={session.token}
        />
    );
}
