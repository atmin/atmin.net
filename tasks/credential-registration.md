# Credential overhaul 1/5 — password-based registration with Argon2id

Part of the credential-overhaul task group:

1. **credential-registration** (this file) — registration UI + Argon2id + salt
2. [credential-rotate-endpoint](credential-rotate-endpoint.md) — server `POST /v1/rotate-keys`
3. [credential-backup-chain](credential-backup-chain.md) — `key_chain.json` + envelope versioning
4. [credential-rotate-ui](credential-rotate-ui.md) — settings UI for "change password"
5. [credential-multi-device-cutoff](credential-multi-device-cutoff.md) — handle `401 key_version_stale`

## Motivation

New users get a 12-word BIP39 mnemonic today and are told to save it.
Most users do not have a habit for that. The goal is a "register with
a password you can actually remember" flow that maintains the same
cryptographic strength via Argon2id stretching. Existing accounts
keep working unchanged (their migration path lives in task 4).

This is the foundation of the credential-overhaul series. It does
not implement rotation — that's task 2 + 4. It does not add the key
chain — that's task 3.

Specs: [ADR-0011](../docs/decisions/adr-0011-credential-derivation.md),
[mvp-v0.1.md#backup-secret](../docs/specs/mvp-v0.1.md#backup-secret),
[mvp-v0.1.md#register-first-device](../docs/specs/mvp-v0.1.md#register-first-device).

## Current state

- [useRegister.ts:30-34](../web/src/hooks/useRegister.ts) generates a
  BIP39 mnemonic on first render and shows it for the user to save.
- [crypto.ts:101-177](../web/src/lib/crypto.ts) `deriveKeys` takes 16
  bytes and runs HKDF-Extract/Expand → auth + sharing + backup keys.
- [register.tsx](../web/src/routes/register.tsx) renders the mnemonic
  + acknowledgement checkboxes + "Register" button.
- [useLogin.ts:32-33](../web/src/hooks/useLogin.ts) does
  `mnemonicToEntropy(mnemonic) → deriveKeys(entropy)`. One code
  path; no autodetect.
- [server/handlers.go](../server/handlers.go) `register` accepts
  `auth_public_key` + `sharing_public_key` only. No salt/kdf fields.
- [server/store.go](../server/store.go) `profile.json` schema in
  Go has no `Salt`/`KDF`/`KeyVersion` fields.
- [web/crypto/Cargo.toml](../web/crypto/Cargo.toml) has `vodozemac`,
  no `argon2`.

## Architecture constraints

- [lint-architecture.sh](../web/scripts/lint-architecture.sh) — no
  `useEffect`/`useCallback`/`useMemo`/`useRef` in `components/`,
  hooks must be `.ts`, no value imports from `@/hooks/` into
  `components/`.
- Argon2id **must** run in a Web Worker (ADR-0011). A ~3–4 s
  synchronous run would block the strength-meter UI and any
  derivation-time animation.
- zxcvbn-ts must be lazy-loaded on the `/register` route. It must
  not enter any other route's bundle.

## Change

### 1. Argon2id in the Rust crate

[web/crypto/Cargo.toml](../web/crypto/Cargo.toml):

```toml
[dependencies]
vodozemac = "0.9"
wasm-bindgen = "0.2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
getrandom = { version = "0.2", features = ["js"] }
argon2 = "0.5"
```

New `web/crypto/src/argon2.rs` exposes:

```rust
#[wasm_bindgen]
pub fn derive_secret(
    password: &[u8],
    salt: &[u8],
    m_kib: u32,
    t: u32,
    p: u32,
) -> Result<Vec<u8>, JsError>
```

Returns 16 bytes. Errors on invalid parameters or salt length ≠ 16.

`make web-wasm` (transitively `make web-build`) picks this up.

### 2. Argon2id Web Worker

New [web/src/lib/argon2-worker.ts](../web/src/lib/argon2-worker.ts)
and [web/src/lib/argon2-worker.client.ts](../web/src/lib/argon2-worker.client.ts):

- Worker imports the WASM module, listens for `{password, salt, kdf}`
  messages, posts `{ok: true, secret: Uint8Array(16)}` or
  `{ok: false, error: string}`.
- Client helper exports `argonStretch(password, salt, kdf): Promise<Uint8Array>`
  that spawns/reuses the worker, posts, awaits the response, kills
  the worker after a short idle.

### 3. Crypto module wires Argon2id ahead of HKDF

[crypto.ts](../web/src/lib/crypto.ts) gains:

```ts
export interface KdfParams {
    type: 'argon2id';
    m: number;  // KiB
    t: number;
    p: number;
}

export const DEFAULT_KDF: KdfParams = { type: 'argon2id', m: 65536, t: 3, p: 1 };

export function generateSalt(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(16));
}
```

Existing `deriveKeys(secret)` is unchanged — it still takes 16 bytes
and runs HKDF. The Argon2id stage lives one level up in the hook,
so derivation is composable.

### 4. zxcvbn-ts strength meter (lazy)

Add `@zxcvbn-ts/core`, `@zxcvbn-ts/language-en`, `@zxcvbn-ts/matcher-pwned`
to [web/package.json](../web/package.json) `dependencies`. Add a
[`tsconfig.json`](../web/tsconfig.json) note if any types need
including (none expected).

New [web/src/lib/password-strength.ts](../web/src/lib/password-strength.ts):

```ts
let scorerPromise: Promise<(p: string) => Promise<Result>> | null = null;

export function loadScorer() {
    if (!scorerPromise) {
        scorerPromise = import('@zxcvbn-ts/core').then(/* options + matcher-pwned */);
    }
    return scorerPromise;
}
```

The matcher-pwned check uses HIBP's k-anonymity API. Best-effort:
on network failure, the local-only score is returned with the
`pwned` flag unset. No retries.

### 5. Password field components

[web/src/components/PasswordField.tsx](../web/src/components/PasswordField.tsx) —
controlled `<input type="password">` with a confirm pair, show/hide
toggle, accessible labels.

[web/src/components/PasswordStrengthMeter.tsx](../web/src/components/PasswordStrengthMeter.tsx) —
4-segment bar + label ("Weak" / "Fair" / "Strong" / "Excellent") +
optional HIBP warning text. Reads score from props.

Both stay presentational (no `useEffect`/`useCallback`/`useMemo`/`useRef`).

### 6. Strength evaluation hook

[web/src/hooks/usePasswordStrength.ts](../web/src/hooks/usePasswordStrength.ts) —
debounced async evaluation. Loads the scorer lazily on first call.
Returns `{score: 0-4, feedback: string[], pwned: boolean, loading: boolean}`.

### 7. Rewrite registration hook

[useRegister.ts](../web/src/hooks/useRegister.ts) — replace mnemonic
generation with a password-based flow:

```ts
export function useRegister(onSuccess) {
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [acknowledged, setAcknowledged] = useState(false);
    const [step, setStep] = useState<'enter' | 'deriving' | 'registering' | 'done'>('enter');
    // ...

    const handleRegister = async () => {
        setStep('deriving');
        const salt = generateSalt();
        const secret = await argonStretch(password, salt, DEFAULT_KDF);  // ~3-4 s
        const keys = await deriveKeys(secret);

        setStep('registering');
        const res = await register({
            device_label: detectDeviceLabel(),
            auth_public_key: base64UrlEncode(keys.auth.publicKeyBytes),
            sharing_public_key: base64UrlEncode(keys.sharing.publicKeyBytes),
            salt: base64UrlEncode(salt),
            kdf: DEFAULT_KDF,
        });
        // ... existing session save
    };
}
```

### 8. Registration route UI

[register.tsx](../web/src/routes/register.tsx) — remove the
mnemonic display block; show the password + confirm + meter +
lockout-acknowledgement checkbox; submit button is disabled until
passwords match and the checkbox is checked. During `deriving` step,
render an animation placeholder (the existing
[AuroraBackground](../web/src/components/AuroraBackground.tsx)
already provides a nice cover — use it or a smaller variant).

The route stays orchestration-only (no `className`).

### 9. Login autodetect

[useLogin.ts](../web/src/hooks/useLogin.ts) — extend `handleLogin`:

```ts
import { validateMnemonic } from '@scure/bip39';

const isLegacyMnemonic = (input: string) => {
    const normalized = input.trim().replace(/\s+/g, ' ');
    const tokens = normalized.split(' ');
    if (tokens.length !== 12) return false;
    if (!tokens.every((t) => wordlist.includes(t))) return false;
    // Checksum gate: 12 valid words with a broken checksum fall through
    // to the password path. Without this, a near-mnemonic (one mistyped
    // word) would route to the legacy decoder and throw a confusing
    // error from `mnemonicToEntropy`.
    return validateMnemonic(normalized, wordlist);
};

const handleLogin = async (handle: string, secretInput: string) => {
    let derivedSecret: Uint8Array;
    let profileKeyVersion = 1;

    if (isLegacyMnemonic(secretInput)) {
        // Legacy direct-HKDF path
        derivedSecret = new Uint8Array(
            mnemonicToEntropy(secretInput.trim(), wordlist),
        );
    } else {
        // v2 password path
        const profile = await resolve(handle);
        if (!profile.salt || !profile.kdf) {
            throw new Error('Recovery phrase required for legacy account.');
        }
        derivedSecret = await argonStretch(
            secretInput,
            base64UrlDecode(profile.salt),
            profile.kdf,
        );
        profileKeyVersion = profile.key_version ?? 1;
    }

    const keys = await deriveKeys(derivedSecret);

    // Build auth proof: v2 (JCS-canonicalized, includes key_version) for
    // rotated accounts (key_version > 1); v1 (legacy JSON.stringify) for
    // everything else. The server accepts both as of Task 2, but v2
    // accounts at key_version: 1 still match v1's implicit kv=1, so this
    // branch only matters once an account has rotated.
    const payload = {
        user_id: userId,
        device_id: deviceId,
        timestamp: new Date().toISOString(),
        ...(profileKeyVersion > 1 ? { key_version: profileKeyVersion } : {}),
    };
    const signature =
        profileKeyVersion > 1
            ? await signAuthProofV2(keys.auth.privateKey, payload)
            : await signAuthProof(keys.auth.privateKey, payload);
    // ... existing add-device flow
};
```

The single text input on the login form keeps its placeholder
("Password or recovery phrase") and accepts both formats.

### 10. API wrappers

[api.ts](../web/src/lib/api.ts):

- `register` request type gains optional `salt: string`, `kdf: KdfParams`.
- `resolve` response type gains optional `salt: string`, `kdf: KdfParams`, `key_version: number`.

### 10a. JCS canonicalization helper + v2 auth-proof signer

`pnpm add canonicalize` (RFC 8785 implementation, ~1 KB). The same
helper is reused by `signContinuity` in Task 2.

[crypto.ts](../web/src/lib/crypto.ts) adds:

```ts
import canonicalize from 'canonicalize';

export function canonicalizeForSign(obj: Record<string, unknown>): Uint8Array {
    const canonical = canonicalize(obj);
    if (canonical === undefined) throw new Error('canonicalize returned undefined');
    return new TextEncoder().encode(canonical);
}

export async function signAuthProofV2(
    privateKey: CryptoKey,
    payload: {
        user_id: string;
        device_id: string;
        timestamp: string;
        key_version: number;
    },
): Promise<Uint8Array> {
    const data = canonicalizeForSign(payload);
    return new Uint8Array(
        await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, data),
    );
}
```

The existing `signAuthProof` (v1, using `JSON.stringify`) is
**kept unchanged**. v1 is frozen on the wire and never regenerated
in v2-only code paths — legacy autodetect login is the only
producer.

### 11. Server: register handler

[server/handlers.go](../server/handlers.go) `register`:

- Accept new optional fields `Salt`, `KDF`.
- Validate: either both present (v2) or both absent (v1). Reject
  partial sets with `bad_request`.
- For v2 registrations, validate the `KDF` shape:
  - `KDF.Type == "argon2id"` (only supported value),
  - `KDF.M >= 8` and `KDF.M <= 1048576` (KiB; floor catches obvious
    misuse, ceiling caps memory at 1 GiB to prevent a client from
    pinning unrealistic params),
  - `KDF.T >= 1` and `KDF.T <= 16`,
  - `KDF.P >= 1` and `KDF.P <= 8`,
  - `Salt` decodes to exactly 16 bytes.

  Any violation returns `400 bad_request`. The server is not
  responsible for *security floor* — the client picks reasonable
  params — but it must refuse values that would brick the account
  (e.g. `m: 0` or `salt: ""`).
- Persist them on `profile.json` along with `key_version: 1` (for
  v2) or omit all three fields (for v1).

[server/store.go](../server/store.go) `Profile` struct:

```go
type Profile struct {
    UserID           string     `json:"user_id"`
    Handle           string     `json:"handle"`
    AuthPublicKey    string     `json:"auth_public_key"`
    SharingPublicKey string     `json:"sharing_public_key"`
    Salt             string     `json:"salt,omitempty"`
    KDF              *KDFParams `json:"kdf,omitempty"`
    KeyVersion       int        `json:"key_version,omitempty"`
    // ... existing optional fields
}

type KDFParams struct {
    Type string `json:"type"`
    M    uint32 `json:"m"`
    T    uint32 `json:"t"`
    P    uint32 `json:"p"`
}
```

`omitempty` on all three v2 fields keeps the v1 wire shape identical
when those values are zero/empty.

### 12. Server: resolve handler

[server/handlers.go](../server/handlers.go) `resolveHandle`: include
`Salt`, `KDF`, `KeyVersion` in the response when the profile has
them. Use `omitempty` semantics so v1 accounts continue to look
identical on the wire.

### 13. MemStore parity

[server/store_mem.go](../server/store_mem.go): make sure `Profile`
round-trips through the in-memory store without loss. Existing
tests should still pass.

## Out of scope

- `POST /v1/rotate-keys` (task 2).
- Token v2 format and `key_version` middleware check (task 2).
- Server-side v2 auth-proof *verification* (task 2). v2 auth proofs
  are *generated* here for forward compatibility, but in practice
  no account reaches `key_version > 1` until task 4 ships, so the
  v2 branch in `useLogin` stays unused in production until then.
- `keys/{uid}/key_chain.json` and envelope versioning (task 3).
- Settings "Change password" UI (task 4).
- Other-device cutoff on rotation (task 5).
- Forced migration of existing v1 accounts. They keep working via
  the legacy code path; their upgrade happens through task 4.

## Verify

`make fmt lint test` clean.

**Unit tests (Vitest):**

- `argon2-wasm.test.ts` (new) — **integration test against the
  real WASM module**, not a mock. Imports the Node target
  (`web/crypto/pkg-node/`) directly, calls `derive_secret` with
  test-tuned parameters (`m: 8, t: 1, p: 1`) over a known
  `(password, salt)` pair, asserts the output matches an RFC 9106
  Appendix A vector or a captured-once fixed value. Confirms the
  binding produces the right algorithm — the mocked worker test
  below would happily pass on a broken binding.
- `argon2-worker.test.ts` — mock the worker; assert request/response
  shape; assert error propagation.
- `password-strength.test.ts` — known weak/medium/strong inputs hit
  expected score buckets; HIBP-match returns `pwned: true` against
  a mocked fetch with a known-leaked password; HIBP-match returns
  `pwned: false` on a 404 / no-match response; offline mock falls
  through without throwing.
- `useRegister.test.ts` — happy path with mocked `argonStretch`,
  `deriveKeys`, `register`; assert the request payload includes
  `salt` and `kdf`; assert v1 payload (no salt/kdf) when not
  configured.
- `useLogin.test.ts` — `isLegacyMnemonic` test matrix:
  - 12 valid BIP39 words with **valid** checksum → returns `true`.
  - 12 valid BIP39 words with **broken** checksum (one word
    swapped) → returns `false` (falls through to password path).
  - `"password123"` → `false`.
  - 11 valid words → `false`.
  - 12 valid words with extra whitespace / mixed case in
    separators → normalised correctly.

  Plus: v2 login fetches resolve, derives via Argon2id, emits
  **v2 auth proof** when `resolve.key_version > 1`. v2 login at
  `key_version: 1` emits **v1 auth proof** (the v2 branch is
  unused until a rotation happens). v1 login decodes directly,
  emits v1 auth proof.
- `crypto.test.ts` (extend) — `canonicalizeForSign` produces the
  RFC 8785 §3.2.3 example byte sequence; `signAuthProofV2` round-
  trips with a manual verifier (`crypto.subtle.verify` over the
  same canonicalized bytes).

**Storybook:**

- `PasswordField` — empty / typing / confirm-mismatch / show-hide.
- `PasswordStrengthMeter` — score 0–4 / pwned flag.
- `RegisterForm` — `enter` step / `deriving` step (with derivation
  animation) / error state.

**Server (Go):**

- `register` accepts v2 fields and writes them to `profile.json`.
- `register` without v2 fields stores a clean v1 profile (no
  `salt`/`kdf`/`key_version` keys on the wire).
- `register` rejects half-supplied v2 fields with
  `400 bad_request`.
- `register` rejects malformed KDF params (table-driven test):
  - `kdf.type: "scrypt"` → 400
  - `kdf.m: 0` → 400
  - `kdf.m: 2097152` (2 GiB, over the cap) → 400
  - `kdf.t: 0` → 400
  - `kdf.t: 100` → 400
  - `kdf.p: 0` → 400
  - `salt: ""` → 400
  - `salt` decoding to !=16 bytes → 400
  - canonical valid params `{type: argon2id, m: 65536, t: 3, p: 1}`
    + 16-byte salt → 200 (regression guard).
- `resolveHandle` returns v2 fields for a v2 account, omits them
  for a v1 account.

**Playwright e2e:**

- New spec `web/e2e/credential-registration.spec.ts`: Alice
  registers with a password, Bob registers with a password, Alice
  opens a chat with Bob, exchange one message in each direction,
  both decrypt. Assert the "Recovery phrase" UI is **not** present
  on the registration page.

**Manual:**

- Register on Pixel 4a-class device (or comparable in throttled
  Chrome DevTools). Confirm derivation completes within ~4 s.
- Log out, log back in with the same password on the same device —
  derivation runs again, keys match (chat history decrypts).
- Type a weak password (`letmein`), confirm meter shows red and
  HIBP warning fires; submission still proceeds (warn-not-block).
- Open DevTools Network tab; confirm `zxcvbn-ts` chunks load
  **only** when on `/register`.
