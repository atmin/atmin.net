# Cover remaining server code paths: static SPA fallback, no-msg_id dedup, log/IP edge cases

## Spec
- `docs/specs/mvp-v0.1.md` "Compaction" — `deduplicateByMsgID` must keep objects without `msg_id` (key backups). Quote: *"first occurrence wins; objects without `msg_id` such as key backups are always kept"*.
- `docs/decisions/adr-0010-logging.md` "Anonymization": IP addresses are PII; any future logging change touching them must be auditable. Implies the IP-extraction code path is worth testing.
- `docs/specs/mvp-v0.1.md` does not specify the SPA-fallback behaviour explicitly, but the embedded server is the only delivery channel for the PWA, so the fallback must work for client-side routing.

## Current
Three uncovered code paths:

1. **`server/static.go` — SPA fallback.** No test. The handler does `path.Clean`, opens the file from the embed FS, and falls back to `index.html` on missing files. This is one of the simpler pieces of code in the repo, but a regression here breaks every deep link in the app.
2. **`deduplicateByMsgID` mixed-input case.** `TestCompactSameDayDedup` covers messages with `msg_id`. There is no test that mixes envelopes (with `msg_id`) and key-backup objects (without `msg_id`) in the same compact pass and asserts the latter are kept.
3. **`remoteIP` and `logRequests`.** No tests for the XFF parsing edge cases (multi-IP, whitespace) or the log-line shape. ADR-0010 makes this PII-relevant.

## Change

### 12a. Static SPA fallback (`server/static_test.go`)
- `TestServeStatic_KnownAsset`: build a `serveStatic()` handler with a tiny embed-fs equivalent (use `http.NewServeMux` + a `fstest.MapFS`-style fixture — or, since `static.go` reads a real `embed.FS`, accept testing the integration via `newMux` after dropping a couple of files into `server/dist/`. Pragmatic: skip if too painful, OR add a thin seam — `serveStaticFromFS(fs.FS) http.Handler` — and test it).
- `TestServeStatic_FallbackToIndex`: GET `/random/route` → expect 200 + body containing some marker from `index.html`.
- `TestServeStatic_NoTraversal`: GET `/../etc/passwd` → must not escape (returns index.html, since the file does not exist within the embed FS).

If extracting a seam is undesirable, at minimum add a manual run note to `docs/ops.md` explaining how to verify SPA routing post-deploy (curl `/login`, expect HTML).

### 12b. No-msg_id dedup (`server/handlers_test.go`)
Add `TestCompactKeepsNoMsgIDObjects`:
- Use `keys/{uid}/live/` prefix.
- Plant two key-backup-shaped objects (`{"iv": "...", "ciphertext": "..."}`) — no `msg_id`.
- Plant an envelope with `msg_id`.
- Compact `keys/{uid}/live/` up to a cursor that includes all three.
- Decode the resulting CBOR archive; assert all three are present.
- Optional: a follow-up dedup test where two envelopes share a `msg_id` AND two no-msg_id objects exist — only one envelope survives, both no-msg_id objects survive.

### 12c. remoteIP + logRequests (covered in task 03's `middleware_test.go`)
This bullet is here for completeness only — task 03 already adds `TestRemoteIP_XFFParsing`. If task 03 has not landed when you do 12, fold the IP test in here. Otherwise, just add `TestLogRequests_StatusAndUserID`:
- Wrap a handler that writes 200 with a user_id in context; assert the captured log line contains `status=200`, `dur_ms=<int>`, `user_id=<id>`. Use `slog.NewTextHandler(&buf, nil)` and `slog.SetDefault` for the duration of the test.

## Verify
- `cd server && go test ./...` passes including the new tests.
- `go test -run 'TestServeStatic|TestCompactKeepsNoMsgIDObjects|TestLogRequests' ./...` resolves each by name.
- Coverage report (`go test -cover ./...`) shows non-zero coverage for `static.go` and the `remoteIP` / `logRequests` lines in `middleware.go`.
