# Reconcile media Cache-Control spec vs implementation

## Spec
`docs/specs/mvp-v0.1.md` (search "Cache-Control") states media blobs are served with:
```
Cache-Control: private, immutable, max-age=31536000
```

## Current
`server/handlers.go` (the `handleStoreObject` handler, the `if strings.HasPrefix(key, "media/")` branch) sets:
```
Cache-Control: public, immutable, max-age=31536000
```
The inline comment justifies `public`: browsers do not cache responses to requests that carry an `Authorization` header unless the response is `public` (RFC 9111 §3.5). The bytes are GCM-sealed ciphertext, so shared caching is safe. The rationale is sound; the spec line is stale.

## Change
Update `docs/specs/mvp-v0.1.md` "Client-side lifecycle" / "Cache-Control" mention from `private` to `public`. Add one sentence explaining why (RFC 9111 §3.5 + ciphertext is opaque). Do not touch the server code.

## Verify
- `grep -n "Cache-Control" docs/specs/mvp-v0.1.md server/handlers.go` shows the same value (`public, immutable, max-age=31536000`) in both.
- No code change → no test change.
