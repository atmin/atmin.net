import ProfileSettings from '@/components/ProfileSettings';
import type { Session } from '@/lib/auth';

interface Props {
    session: Session;
}

export default function SettingsRoute({ session }: Props) {
    return <ProfileSettings handle={session.handle} token={session.token} />;
}
