import PasswordInput from '@/components/PasswordInput';

interface Props {
    password: string;
    confirm: string;
    onPasswordChange: (value: string) => void;
    onConfirmChange: (value: string) => void;
    disabled?: boolean;
}

export default function PasswordField({
    password,
    confirm,
    onPasswordChange,
    onConfirmChange,
    disabled,
}: Props) {
    const mismatch = confirm.length > 0 && confirm !== password;

    return (
        <div className="space-y-4">
            <div>
                <label
                    htmlFor="password"
                    className="mb-1 block text-sm font-medium"
                >
                    Password
                </label>
                <PasswordInput
                    id="password"
                    value={password}
                    onChange={onPasswordChange}
                    disabled={disabled}
                    autoComplete="new-password"
                />
            </div>

            <div>
                <label
                    htmlFor="confirm"
                    className="mb-1 block text-sm font-medium"
                >
                    Confirm password
                </label>
                <PasswordInput
                    id="confirm"
                    value={confirm}
                    onChange={onConfirmChange}
                    disabled={disabled}
                    autoComplete="new-password"
                    ariaInvalid={mismatch}
                />
                {mismatch && (
                    <p className="mt-1 text-xs text-destructive">
                        Passwords do not match.
                    </p>
                )}
            </div>
        </div>
    );
}
