import RegisterForm from '@/components/RegisterForm';
import { useHandleAvailability } from '@/hooks/useHandleAvailability';
import { usePasswordStrength } from '@/hooks/usePasswordStrength';
import { useRegister } from '@/hooks/useRegister';
import type { Session } from '@/lib/auth';
import { suggestHandle } from '@/lib/handle-suggest';

interface Props {
    onSuccess: (session: Session) => void;
}

export default function RegisterRoute({ onSuccess }: Props) {
    const reg = useRegister(onSuccess);
    const strength = usePasswordStrength(reg.password);
    const availability = useHandleAvailability(reg.handle);

    return (
        <RegisterForm
            step={reg.step}
            handle={reg.handle}
            password={reg.password}
            confirm={reg.confirm}
            acknowledged={reg.acknowledged}
            error={reg.error}
            powStatus={reg.powStatus}
            provingMs={reg.provingMs}
            powHashes={reg.powHashes}
            strength={strength}
            availability={availability}
            onHandleChange={reg.setHandle}
            onSurpriseMe={() => reg.setHandle(suggestHandle())}
            onPasswordChange={reg.setPassword}
            onConfirmChange={reg.setConfirm}
            onAcknowledgedChange={reg.setAcknowledged}
            onRegister={reg.handleRegister}
        />
    );
}
