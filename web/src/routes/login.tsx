import LoginForm from '@/components/LoginForm';
import { useLogin } from '@/hooks/useLogin';
import type { LoginNotice } from '@/hooks/useSession';
import type { Session } from '@/lib/auth';

interface Props {
    onSuccess: (session: Session) => void;
    notice?: LoginNotice;
    onDismissNotice?: () => void;
}

export default function LoginRoute({
    onSuccess,
    notice = null,
    onDismissNotice,
}: Props) {
    const { loading, error, handleLogin } = useLogin(onSuccess);

    return (
        <LoginForm
            loading={loading}
            error={error}
            // Both rotated_elsewhere and account_deleted can land here (a
            // deleted session's background 401 redirects a protected route to
            // /login); the form renders either confirmation.
            notice={notice}
            onDismissNotice={onDismissNotice}
            onLogin={handleLogin}
        />
    );
}
