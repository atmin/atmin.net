/**
 * Lazy zxcvbn-ts password scorer with opportunistic HIBP matching.
 *
 * The zxcvbn-ts core, the English language pack, and the pwned matcher
 * are all dynamic-imported inside `loadScorer` so they form their own
 * chunk and only load on the registration route — they must never enter
 * any other route's bundle (ADR-0011).
 *
 * The HIBP check goes through the matcher's k-anonymity API (SHA-1
 * prefix; the service never sees the full hash). It is best-effort: the
 * matcher's default network-error handler swallows failures, so an
 * offline or blocked request just yields a local-only score with
 * `pwned: false`. No retries.
 */

export interface StrengthResult {
    score: 0 | 1 | 2 | 3 | 4;
    feedback: string[];
    pwned: boolean;
}

export type Scorer = (password: string) => Promise<StrengthResult>;

let scorerPromise: Promise<Scorer> | null = null;

export function loadScorer(): Promise<Scorer> {
    if (!scorerPromise) {
        scorerPromise = buildScorer();
    }
    return scorerPromise;
}

async function buildScorer(): Promise<Scorer> {
    const [{ zxcvbnAsync, zxcvbnOptions }, en, { matcherPwnedFactory }] =
        await Promise.all([
            import('@zxcvbn-ts/core'),
            import('@zxcvbn-ts/language-en'),
            import('@zxcvbn-ts/matcher-pwned'),
        ]);

    zxcvbnOptions.setOptions({
        dictionary: en.dictionary,
        translations: en.translations,
    });

    // Late-bind fetch so tests stubbing globalThis.fetch are honoured and
    // the matcher always sees the current implementation.
    const matcherPwned = matcherPwnedFactory(
        (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
        zxcvbnOptions,
    );
    zxcvbnOptions.addMatcher('pwned', matcherPwned);

    return async (password: string): Promise<StrengthResult> => {
        const result = await zxcvbnAsync(password);
        const feedback = [
            ...(result.feedback.warning ? [result.feedback.warning] : []),
            ...result.feedback.suggestions,
        ];
        const pwned = result.sequence.some((m) => m.pattern === 'pwned');
        return { score: result.score, feedback, pwned };
    };
}
