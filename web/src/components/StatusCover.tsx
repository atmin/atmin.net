import { Block, Preloader } from 'konsta/react';

interface Props {
    /** What's happening — e.g. "Deriving your keys…". */
    label: string;
    /**
     * Tints the spinner red for destructive operations (account deletion).
     * Default is the primary-coloured spinner used by every other long-running
     * crypto step (register / login derive, password change).
     */
    destructive?: boolean;
}

/**
 * Full-width centred cover shown while a long-running on-device crypto step is
 * in progress (Argon2id derivation, key rotation, account teardown). Konsta
 * `Preloader` is the single "work in progress" spinner across the app (ADR-0023
 * T3) — it replaced the bespoke three-pulsing-dots so every such moment looks
 * the same on iOS and Material.
 */
export default function StatusCover({ label, destructive = false }: Props) {
    return (
        <Block className="py-10 text-center">
            <div className="mb-4 flex justify-center">
                <Preloader
                    colors={
                        destructive
                            ? {
                                  iconIos: 'text-red-500',
                                  iconMaterial: 'text-red-500',
                              }
                            : undefined
                    }
                />
            </div>
            <p className="text-sm font-medium">{label}</p>
        </Block>
    );
}
