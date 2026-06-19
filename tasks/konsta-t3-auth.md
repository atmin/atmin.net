# Konsta migration T3 — auth flow (landing / login / register)

> Part of the **Konsta UI migration** ([ADR-0023](../docs/decisions/adr-0023-konsta-ui.md)).
> Needs **T0**. Forms + bespoke password/handle UX. Redesign, not a port (Konsta
> kitchen-sink catalog).

## Goal

Rebuild the unauthenticated flow native-feel, fitting the live handle-availability
and password-strength UX into Konsta inputs. **Kill `AuroraBackground`** as part
of the landing redesign.

## Scope (files)

- `web/src/routes/landing.tsx`, `login.tsx`, `register.tsx`
- `web/src/components/LandingPage.tsx` — redesign; **remove the AuroraBackground
  usage** (the `ui/AuroraBackground.tsx` primitive + `AuroraBackground.stories.tsx`
  are deleted in T6).
- `web/src/components/LoginForm.tsx`, `RegisterForm.tsx`
- `web/src/components/PasswordField.tsx`, `PasswordInput.tsx`,
  `PasswordStrengthMeter.tsx`

## Konsta components (catalog)

`Page`, `Block`/`BlockTitle`, `List`/`ListInput` (handle, password, confirm),
`Button`, `Checkbox`/`Toggle` (the "I understand" ack), `Preloader` (Argon2id /
registration progress). Keep the live handle-availability indicator and the
password-strength meter as custom elements composed with the Konsta inputs (the
strength meter can stay a thin custom bar).

## Storybook

Rewrite `LoginForm`, `RegisterForm`, `PasswordField`, `PasswordInput`,
`PasswordStrengthMeter`, `LandingPage` stories. Delete `AuroraBackground.stories.tsx`
here or in T6 (note it).

## e2e

`credential-registration.spec.ts`, `custom-handles.spec.ts`, login flows in
`helpers.ts` (`registerUserWithPassword`, `loginUser`) — the `#handle`/`#password`
/`#confirm` ids, the availability text, the ack checkbox role, the Register/Sign
In buttons. Preserve ids/labels where cheap, else update helpers.

## shadcn retired

`button`, `checkbox`, `card` used by auth — drop locally once unreferenced.

## Done when

- Auth flow is Konsta; AuroraBackground gone from landing; handle-availability +
  strength UX intact; stories updated; registration/login e2e green;
  `make fmt lint`, `pnpm tsc`, `pnpm build` green.
