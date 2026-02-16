# Read CBOR-compacted message archives on client

## Spec
`docs/specs/mvp-v0.1.md` line ~268: archives at `inbox/{userId}/archive/{YYYY-MM-DD}` are CBOR arrays of envelope maps. Client library: `cbor-x`.

## Current
`web/src/lib/api.ts` `fetchMessages()` only reads `inbox/{userId}/live/` (JSON). No code reads the `archive/` prefix. No `cbor-x` dependency in `package.json`.

## Change
1. `cd web && npm install cbor-x`
2. In `api.ts` (or a new `archives.ts` in `lib/`): add a function to list `inbox/{userId}/archive/`, fetch each blob, decode with `cbor-x`, and return envelopes in the same shape as live ones.
3. Integrate into the sync flow: after processing live messages, check for archives (newest first). Process key shares first, then messages, same as live.
4. For new-device sync per spec: walk archives in reverse date order, oldest loaded lazily.

## Verify
- `cd web && npx tsc --noEmit` passes
- `cd web && npm test` passes
- Manual: trigger compaction via API, then load chat — archived messages still appear
