import RegisterForm from '@/components/RegisterForm';
import { useRegister } from '@/hooks/useRegister';
import type { Session } from '@/lib/auth';

interface Props {
    onSuccess: (session: Session) => void;
}

export default function RegisterRoute({ onSuccess }: Props) {
    const { step, mnemonic, error, handleRegister } = useRegister(onSuccess);

    return (
        <RegisterForm
            step={step}
            mnemonic={mnemonic}
            error={error}
            onRegister={handleRegister}
        />
    );
}
