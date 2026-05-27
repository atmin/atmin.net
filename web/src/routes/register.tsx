import RegisterForm from '@/components/RegisterForm';
import { usePasswordStrength } from '@/hooks/usePasswordStrength';
import { useRegister } from '@/hooks/useRegister';
import type { Session } from '@/lib/auth';

interface Props {
    onSuccess: (session: Session) => void;
}

export default function RegisterRoute({ onSuccess }: Props) {
    const reg = useRegister(onSuccess);
    const strength = usePasswordStrength(reg.password);

    return (
        <RegisterForm
            step={reg.step}
            password={reg.password}
            confirm={reg.confirm}
            acknowledged={reg.acknowledged}
            error={reg.error}
            strength={strength}
            onPasswordChange={reg.setPassword}
            onConfirmChange={reg.setConfirm}
            onAcknowledgedChange={reg.setAcknowledged}
            onRegister={reg.handleRegister}
        />
    );
}
