# Rename envelope `timestamp` to `sent_at` (ISO 8601 string)

## Spec
`docs/specs/mvp-v0.1.md` defines the envelope format with `"sent_at": "<ISO 8601>"` as a string field.

## Current
`web/src/lib/api.ts` uses `timestamp?: number` (milliseconds since epoch) in the `Envelope` type and throughout `sendMessage()`. The field name and type both differ from spec.

## Change
1. In `web/src/lib/api.ts`: rename `timestamp` to `sent_at` in the `Envelope` type, change type to `string`, emit `new Date().toISOString()` on send.
2. In `web/src/lib/api.ts` `fetchMessages()`: parse `sent_at` with `new Date(envelope.sent_at)` where messages are constructed.
3. In `web/src/lib/db.ts`: the `Message` type uses `timestamp: Date` — that internal representation is fine, just ensure the serialization boundary in `api.ts` converts correctly.
4. Update any tests in `web/src/lib/api.test.ts` that reference the old field name.

## Verify
- `cd web && npx tsc --noEmit` passes
- `cd web && npm test` passes
- `make e2e` passes (two users exchange messages, timestamps display correctly)
