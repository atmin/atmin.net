import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';

interface Props {
    id: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
    autoComplete?: string;
    ariaInvalid?: boolean;
}

/** Masked text input with a show/hide eye toggle. */
export default function PasswordInput({
    id,
    value,
    onChange,
    placeholder,
    disabled,
    autoComplete,
    ariaInvalid,
}: Props) {
    const [show, setShow] = useState(false);

    return (
        <div className="relative">
            <input
                id={id}
                type={show ? 'text' : 'password'}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                disabled={disabled}
                autoComplete={autoComplete}
                aria-invalid={ariaInvalid}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 pr-10 text-sm aria-invalid:border-red-500"
            />
            <button
                type="button"
                onClick={() => setShow((s) => !s)}
                disabled={disabled}
                aria-label={show ? 'Hide password' : 'Show password'}
                className="absolute inset-y-0 right-0 flex items-center px-3 opacity-60 hover:opacity-100"
            >
                {show ? (
                    <EyeOff className="size-4" />
                ) : (
                    <Eye className="size-4" />
                )}
            </button>
        </div>
    );
}
