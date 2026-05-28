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
            notice={notice}
            onDismissNotice={onDismissNotice}
            onLogin={handleLogin}
        />
    );
}
