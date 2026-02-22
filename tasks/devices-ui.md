# Devices UI — list devices and revoke stolen device

## Spec
`docs/scenarios/stolen-device.md`: Alice revokes her stolen phone from her laptop. The phone self-wipes on next API call.

Server already has `POST /v1/devices/revoke` (requires `auth_proof` signed with Ed25519 auth key derived from mnemonic). Device files live at `users/{userId}/devices/{deviceId}.json`.

## Current
No UI to list or revoke devices. The server endpoint exists and is tested (`server/handlers_test.go`). Client has no `revokeDevice()` API function and no Devices section in settings.

## Change

### 1. API function
In `web/src/lib/api.ts`, add:
- `listDevices(token, userId)` — `GET /v1/store/list?prefix=users/{userId}/devices/` + `GET` each device JSON.
- `revokeDevice(token, deviceId, authProof)` — `POST /v1/devices/revoke`.

### 2. Revocation proof
Revoking requires the user to enter their 12-word mnemonic to derive the Ed25519 auth key and sign `{ user_id, device_id, timestamp }`. Reuse the existing `deriveKeys()` + `signAuthProof()` from `web/src/lib/crypto.ts` (same pattern as `useLogin.ts`).

### 3. Devices settings panel
Add a `DeviceSettings` component rendered in `web/src/routes/settings.tsx` below `ProfileSettings`. It should:
- List all devices (label + device ID, highlight "this device").
- Each non-current device gets a "Revoke" button.
- Clicking "Revoke" prompts for the mnemonic, signs the auth proof, calls `revokeDevice()`.
- On success, refresh the device list.

### 4. E2e test (`web/e2e/stolen-device.spec.ts`)
Following the stolen-device scenario from the user's perspective:
1. Alice registers on laptop (with mnemonic), Bob registers.
2. Alice adds her phone (second device via `loginUser()`).
3. Bob sends "Hey Alice", phone syncs and sees it.
4. Alice opens Settings on laptop, sees two devices listed.
5. Alice clicks "Revoke" on the phone, enters mnemonic, confirms.
6. Device list now shows only the laptop.
7. Phone navigates or triggers a sync — sees welcome/landing screen (self-wipe triggered by `403 device_revoked`).
8. Phone's IndexedDB is gone (verify via `indexedDB.databases()` or attempt to open).
9. Bob sends "Post-revocation msg", laptop sees it, phone does not.

## Verify
- `cd web && npx tsc --noEmit` passes
- `cd web && npm test` passes
- `cd web && npx playwright test stolen-device` passes
