# Client-side encrypted media upload and download

## Spec
`docs/specs/mvp-v0.1.md` line ~448: client generates random AES-256-GCM key + 12-byte IV, encrypts file, computes SHA-256 of plaintext, presigns upload to `media/{userId}/{sha256}/{filename}`, uploads encrypted blob, sends Megolm-encrypted message with `{"type": "media", "body": "filename", "file": {"url", "key", "iv", "sha256"}}`.

## Current
`web/src/components/ChatView.tsx` has text-only input. No file picker, no encryption, no presigned media upload, no media message rendering.

## Change
1. In `web/src/lib/`: add `encryptMedia(file: File)` → `{encryptedBlob, key, iv, sha256}` and `decryptMedia(blob, key, iv, sha256)` → `Blob`.
2. In `web/src/lib/api.ts`: add media upload flow (presign, PUT, construct media envelope payload).
3. In `web/src/components/ChatView.tsx`: add file input button, render media messages (images inline, others as download links).
4. In `web/src/hooks/useChat.ts`: wire `sendMedia()` alongside existing `sendMessage()`.

## Verify
- `cd web && npx tsc --noEmit` passes
- `cd web && npm test` passes
- Manual: send an image, recipient sees it decrypted
