import {
    Block,
    BlockTitle,
    Button,
    Checkbox,
    Navbar,
    NavbarBackLink,
    Page,
} from 'konsta/react';
import { useNavigate } from 'react-router-dom';
import PasswordField from '@/components/PasswordField';
import PasswordStrengthMeter from '@/components/PasswordStrengthMeter';
import StatusCover from '@/components/StatusCover';
import type { HandleAvailability } from '@/hooks/useHandleAvailability';
import type { PasswordStrength } from '@/hooks/usePasswordStrength';
import type { PowStatus, RegisterStep } from '@/hooks/useRegister';

interface Props {
    step: RegisterStep;
    handle: string;
    password: string;
    confirm: string;
    acknowledged: boolean;
    error: string;
    powStatus: PowStatus;
    provingMs: number;
    powHashes: number;
    strength: PasswordStrength;
    availability: HandleAvailability;
    onHandleChange: (value: string) => void;
    onSurpriseMe: () => void;
    onPasswordChange: (value: string) => void;
    onConfirmChange: (value: string) => void;
    onAcknowledgedChange: (value: boolean) => void;
    onRegister: () => void;
}

const AVAILABILITY_COLORS: Record<HandleAvailability['status'], string> = {
    idle: 'opacity-60',
    invalid: 'text-red-500',
    checking: 'opacity-60',
    available: 'text-green-600',
    taken: 'text-red-500',
    released: 'text-red-500',
    error: 'text-red-500',
};

export default function RegisterForm({
    step,
    handle,
    password,
    confirm,
    acknowledged,
    error,
    powStatus,
    provingMs,
    powHashes,
    strength,
    availability,
    onHandleChange,
    onSurpriseMe,
    onPasswordChange,
    onConfirmChange,
    onAcknowledgedChange,
    onRegister,
}: Props) {
    const navigate = useNavigate();

    const canSubmit =
        availability.status === 'available' &&
        password.length > 0 &&
        password === confirm &&
        acknowledged;

    // PoW calibration readout (ADR-0020): grind time, attempts, per-hash cost.
    const powReadout =
        powHashes > 0 ? (
            <Block className="text-center font-mono text-xs tabular-nums opacity-60">
                PoW: {(provingMs / 1000).toFixed(1)}s · {powHashes} hashes · ~
                {(provingMs / powHashes).toFixed(1)} ms/hash
            </Block>
        ) : null;

    // ── Long on-device steps: shared Preloader cover (ADR-0023 T3) ──
    if (step === 'deriving' || step === 'proving') {
        return (
            <Page>
                <StatusCover
                    label={
                        step === 'deriving'
                            ? 'Deriving your keys…'
                            : 'Verifying your device…'
                    }
                />
                <Block className="text-center text-sm opacity-60">
                    This takes a few seconds and runs entirely on your device.
                </Block>
                {step === 'proving' && (
                    <Block className="text-center font-mono text-sm tabular-nums opacity-60">
                        {(provingMs / 1000).toFixed(1)}s
                    </Block>
                )}
            </Page>
        );
    }

    if (step === 'registering') {
        return (
            <Page>
                <StatusCover label="Creating your account…" />
                {powReadout}
            </Page>
        );
    }

    if (step === 'done') {
        return (
            <Page>
                <Block className="pt-10 text-center text-green-600">
                    ✓ Account created successfully
                </Block>
                <Block className="text-center text-sm opacity-60">
                    Redirecting…
                </Block>
                {powReadout}
            </Page>
        );
    }

    // Background-PoW status on the form, with the calibration numbers once ready.
    // Failed → nothing; the submit path solves inline.
    const powStatusLine =
        powStatus === 'failed' ? null : (
            <Block className="text-center text-xs tabular-nums opacity-60">
                {powStatus === 'ready'
                    ? '🔒 Secure registration ready'
                    : `🔒 Preparing secure registration… ${(provingMs / 1000).toFixed(0)}s`}
                {powStatus === 'ready' &&
                    powHashes > 0 &&
                    ` · ${powHashes} hashes · ~${(provingMs / powHashes).toFixed(1)} ms/hash`}
            </Block>
        );

    // ── step === 'enter' ──
    return (
        <Page>
            <Navbar
                title="Create account"
                left={
                    <NavbarBackLink text="Back" onClick={() => navigate('/')} />
                }
            />

            <BlockTitle>Pick a handle</BlockTitle>
            <Block className="text-sm opacity-70">
                Other people will use this to find you. 3–32 lowercase letters,
                digits, or hyphens.
            </Block>
            <Block strong inset className="space-y-2">
                <label htmlFor="handle" className="sr-only">
                    Handle
                </label>
                <div className="flex items-center gap-2">
                    <span className="select-none opacity-60">@</span>
                    <input
                        id="handle"
                        type="text"
                        value={handle}
                        onChange={(e) =>
                            onHandleChange(e.target.value.toLowerCase())
                        }
                        autoComplete="username"
                        placeholder="alice-test"
                        className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm"
                    />
                    <Button
                        inline
                        outline
                        onClick={onSurpriseMe}
                        data-testid="surprise-me"
                        className="whitespace-nowrap"
                    >
                        Surprise me
                    </Button>
                </div>
                {availability.message && (
                    <p
                        className={`text-xs ${AVAILABILITY_COLORS[availability.status]}`}
                        data-testid="handle-availability"
                    >
                        {availability.message}
                    </p>
                )}
            </Block>

            <BlockTitle>Choose a password</BlockTitle>
            <Block className="text-sm opacity-70">
                Your password derives your encryption keys locally. It's never
                sent anywhere or stored.
            </Block>
            <Block strong inset className="space-y-4">
                <PasswordField
                    password={password}
                    confirm={confirm}
                    onPasswordChange={onPasswordChange}
                    onConfirmChange={onConfirmChange}
                />
                {password.length > 0 && (
                    <PasswordStrengthMeter
                        score={strength.score}
                        feedback={strength.feedback}
                        pwned={strength.pwned}
                        loading={strength.loading}
                    />
                )}
            </Block>

            <BlockTitle>⚠️ Critical security warning</BlockTitle>
            <Block strong inset className="space-y-2 text-sm">
                <p>
                    There is no password reset. If you forget this password and
                    lose your devices, your account and message history are gone
                    forever.
                </p>
                <p>
                    Store it in a password manager like{' '}
                    <a
                        href="https://en.wikipedia.org/wiki/List_of_password_managers"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                    >
                        1Password, Bitwarden, or KeePass
                    </a>
                    .
                </p>
            </Block>

            <Block strong inset>
                <Checkbox
                    checked={acknowledged}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        onAcknowledgedChange(e.target.checked)
                    }
                    data-testid="register-ack"
                >
                    <span className="text-sm">
                        I understand that my password cannot be reset and is the
                        only way to recover my account
                    </span>
                </Checkbox>
            </Block>

            {error && <Block className="text-sm text-red-500">{error}</Block>}

            <Block>
                <Button large onClick={onRegister} disabled={!canSubmit}>
                    Register
                </Button>
            </Block>

            {powStatusLine}
        </Page>
    );
}
