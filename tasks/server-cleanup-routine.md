# Server data retention cleanup

## Motivation

[adr-0006-data-retention.md](../docs/decisions/adr-0006-data-retention.md)
specifies two retention policies (abandoned registration, inactive user) and a
single idempotent cleanup routine. `last_active` tracking is already implemented
([events.go:112-138](../server/events.go)); the cleanup routine itself is not.
Without it, handles, profiles, inboxes, keys, and media accumulate forever.

The ADR's preferred deployment is an **external scheduled job invoking a CLI
subcommand** (lines 83-85). An in-process ticker is rejected here: the server
is stateless by design (see [CONTRIBUTING.md](../CONTRIBUTING.md) "Backend"),
and the same external scheduler will handle ADR-0010 log export.

## Current state

- No `server/cleanup.go` exists.
- [server/config.go](../server/config.go) has no `Cleanup*` fields.
- [server/main.go](../server/main.go) has no subcommand dispatch — `func main`
  unconditionally starts the HTTP server.
- `last_active` write-on-SSE-connect is already in place
  ([events.go:83-84](../server/events.go), [events.go:114-134](../server/events.go)).
- `Profile` struct already exposes `LastActive` and `CreatedAt`
  ([profile.go:8-17](../server/profile.go)).
- [docs/ops.md](../docs/ops.md) does not document any cleanup env vars yet.

## Change

### 1. `server/config.go` — add fields

```go
type Config struct {
    // ...existing...
    CleanupInactiveDays int
    CleanupBatchSize    int
}
```

In `loadConfig()`:

```go
CleanupInactiveDays: envIntOr("CLEANUP_INACTIVE_DAYS", 180),
CleanupBatchSize:    envIntOr("CLEANUP_BATCH_SIZE", 100),
```

Add `envIntOr(key string, fallback int) int` alongside the existing
`envOr`. `log.Fatalf` on parse error.

No `CleanupEnabled` flag: enablement is "did the cron job invoke the
subcommand?" — the bool would be vestigial.

### 2. `server/cleanup.go` — the routine

```go
package main

import (
    "context"
    "log/slog"
    "time"
)

type CleanupOpts struct {
    InactiveDays int
    BatchSize    int       // max number of users deleted per run
    DryRun       bool      // true = log only, no deletes
    Now          func() time.Time // injectable for tests; nil → time.Now
}

type CleanupResult struct {
    HandlesScanned int
    Abandoned      int
    Inactive       int
    Deleted        int      // actual or would-have-been if DryRun
    Errors         int
}

func runCleanup(ctx context.Context, store Store, opts CleanupOpts) (CleanupResult, error) {
    if opts.Now == nil { opts.Now = time.Now }
    var res CleanupResult
    cursor := ""
    for res.Deleted < opts.BatchSize {
        // List one page of handles/. Page size: min(1000, batchSize - deleted).
        keys, next, err := store.ListObjects(ctx, "handles/", pageSize, cursor)
        if err != nil { return res, err }
        for _, k := range keys {
            res.HandlesScanned++
            if res.Deleted >= opts.BatchSize { break }
            policy, p, err := evaluateUser(ctx, store, k, opts)
            if err != nil { res.Errors++; continue }
            if policy == "" { continue }
            if policy == "abandoned" { res.Abandoned++ } else { res.Inactive++ }
            slog.Info("cleanup match", "user_id", p.UserID, "policy", policy, "dry_run", opts.DryRun)
            if !opts.DryRun {
                if err := deleteUser(ctx, store, p); err != nil { res.Errors++; continue }
            }
            res.Deleted++
        }
        if next == "" { break }
        cursor = next
    }
    return res, nil
}

// evaluateUser returns "abandoned", "inactive", or "" (keep).
func evaluateUser(ctx context.Context, store Store, handleKey string, opts CleanupOpts) (string, *Profile, error) {
    // Read handle file → user_id → profile.
    // ABANDONED: DisplayName == "" AND no inbox/{uid}/live AND no inbox/{uid}/archive AND now - created_at > 7d.
    // INACTIVE:  last_active != "" AND now - last_active > InactiveDays.
    // Order matters: a user with no display_name AND old last_active is "abandoned" (cheaper to verify).
}

// deleteUser deletes everything under users/{uid}/, inbox/{uid}/, keys/{uid}/,
// media/{uid}/, and the handles/{handle}.json file. Idempotent: missing objects ignored.
// Use store.DeleteObjects in batches (≤1000 keys per call — S3 limit).
func deleteUser(ctx context.Context, store Store, p *Profile) error { ... }
```

**Inbox-empty check:** `ListObjects(ctx, prefixInboxLive(uid), 1, "")` then
`ListObjects(ctx, prefixInboxArchive(uid), 1, "")`. Both must return zero keys.

**Idempotency:** `DeleteObjects` is already idempotent on S3; a second run finds
the handle gone and lists nothing.

**Pagination:** loop until `ListObjects` returns empty `nextCursor`. Stop early
when `res.Deleted == BatchSize`. The batch limit caps deletions, not scans, per
ADR-0006 ("process at most N users per run").

### 3. `server/main.go` — subcommand dispatch

```go
func main() {
    slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
    cfg := loadConfig()

    if len(os.Args) > 1 && os.Args[1] == "cleanup" {
        runCleanupCmd(cfg, os.Args[2:])
        return
    }
    runServer(cfg)
}

func runCleanupCmd(cfg Config, args []string) {
    fs := flag.NewFlagSet("cleanup", flag.ExitOnError)
    apply := fs.Bool("apply", false, "actually delete (default: dry-run)")
    fs.Parse(args)

    s3c, err := NewS3Client(context.Background(), cfg)
    if err != nil { slog.Error("s3 client", "err", err); os.Exit(1) }

    res, err := runCleanup(context.Background(), s3c, CleanupOpts{
        InactiveDays: cfg.CleanupInactiveDays,
        BatchSize:    cfg.CleanupBatchSize,
        DryRun:       !*apply,
    })
    if err != nil { slog.Error("cleanup", "err", err); os.Exit(1) }
    slog.Info("cleanup done",
        "scanned", res.HandlesScanned, "abandoned", res.Abandoned,
        "inactive", res.Inactive, "deleted", res.Deleted,
        "errors", res.Errors, "dry_run", !*apply)
}
```

Extract the existing `main` body into `runServer(cfg Config)`. The `cleanup`
subcommand must NOT call `http.ListenAndServe`.

**Dry-run is the default** — explicit `--apply` required to delete. Per
ADR-0006 "Safeguards".

### 4. `server/cleanup_test.go` — tests

Use `MemStore` (no new methods needed — `ListObjects`, `GetObject`,
`DeleteObjects` already exist).

Inject a fixed `Now` to control "age":

```go
now := func() time.Time { return time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC) }
opts := CleanupOpts{InactiveDays: 180, BatchSize: 100, DryRun: false, Now: now}
```

Required cases:

| Test | Setup | Assert |
|---|---|---|
| `TestCleanupAbandoned` | profile with `DisplayName==""`, `CreatedAt=8 days ago`, no inbox objects | user deleted, handle gone, `Abandoned==1` |
| `TestCleanupAbandonedWithinGrace` | same but `CreatedAt=6 days ago` | user kept |
| `TestCleanupAbandonedHasMessages` | `DisplayName==""`, one object under `inbox/{uid}/live/` | user kept (abandoned check fails on inbox) |
| `TestCleanupAbandonedHasDisplayName` | `DisplayName="Alice"`, no inbox, created 30d ago | user kept |
| `TestCleanupInactive` | `LastActive=200 days ago` | user deleted, `Inactive==1` |
| `TestCleanupActive` | `LastActive=30 days ago` | user kept |
| `TestCleanupDryRun` | matching profile + `DryRun=true` | `Deleted==1` but objects still present in MemStore |
| `TestCleanupBatchSizeLimit` | 5 matching users, `BatchSize=2` | exactly 2 deleted, 3 remain |
| `TestCleanupIdempotent` | run twice on same data, second run | second run `Deleted==0` |
| `TestCleanupDeletesAllPrefixes` | matching user with objects under each of `users/`, `inbox/live/`, `inbox/archive/`, `keys/live/`, `keys/archive/`, `media/`, plus `handles/X.json` | all prefixes empty after run |

A test helper `seedUser(store *MemStore, uid, handle string, p Profile, inbox []string, media []string)` keeps cases compact.

### 5. `docs/ops.md` — document env vars and invocation

Add to the env-var table:

| Var | Default | Purpose |
|---|---|---|
| `CLEANUP_INACTIVE_DAYS` | `180` | Deletion threshold for inactive users |
| `CLEANUP_BATCH_SIZE` | `100` | Max users deleted per cleanup run |

Add a "Scheduled cleanup" section under deploy ops:

> The same image runs cleanup as a subcommand. Schedule it as a Scaleway
> serverless job or cron container, daily:
>
> ```sh
> ./atmin cleanup            # dry-run, logs only
> ./atmin cleanup --apply    # actually deletes
> ```
>
> First production deploys should run dry-run for one week and review logs
> before flipping `--apply`. Logs include `user_id`, `policy`, `dry_run`.

(Per ADR-0006 "Safeguards" — dry-run first.)

### 6. No scenario, no ADR, no spec changes

- This is an admin/operator flow with no user-visible surface — no
  `docs/scenarios/*.md` and no Playwright spec.
- Storage layout is unchanged (cleanup only deletes existing prefixes) — no
  edit to [docs/specs/mvp-v0.1.md](../docs/specs/mvp-v0.1.md).
- ADR-0006 already accepted; no new ADR.

## Verify

- `cd server && go test ./...` — all `TestCleanup*` cases above pass.
- `make lint test build` — clean.
- Manual smoke test against local MinIO:
  1. `make dev` to start the stack.
  2. Register two users via the web app; do not set a display name on one.
  3. `./bin/atmin cleanup` → logs show the no-display-name user as a
     would-be-abandoned match only if you can age `created_at` past 7 days
     (skip in smoke if not).
  4. `./bin/atmin cleanup --apply` → re-running shows zero matches
     (idempotency).
- Confirm by listing the bucket: deleted user's `users/`, `inbox/`, `keys/`,
  `media/`, and `handles/{handle}.json` are all gone.
