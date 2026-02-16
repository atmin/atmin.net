import LoginForm from '@/components/LoginForm';
import { useLogin } from '@/hooks/useLogin';
import type { Session } from '@/lib/auth';

interface Props {
    onSuccess: (session: Session) => void;
}

export default function LoginRoute({ onSuccess }: Props) {
    const { loading, error, handleLogin } = useLogin(onSuccess);

    return <LoginForm loading={loading} error={error} onLogin={handleLogin} />;
}
