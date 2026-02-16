# Implement server data retention cleanup

## Spec
`docs/decisions/adr-0006-data-retention.md` defines:
- Config: `CLEANUP_ENABLED` (bool), `CLEANUP_INACTIVE_DAYS` (default 180), `CLEANUP_BATCH_SIZE` (default 100).
- Two policies: abandoned registration (no `display_name` + no messages, >7 days after `created_at`), inactive user (`last_active` >180 days).
- Cleanup lists all `invites/*.json`, reads each profile, evaluates policies, deletes all prefixes (`users/{uid}/`, `inbox/{uid}/`, `backups/{uid}/`, `media/{uid}/`, `invites/{handle}.json`).
- Idempotent. Can run as in-process goroutine on ticker or CLI subcommand. Dry-run by default.

## Current
Server has no cleanup code, no config params, no CLI subcommand. `server/config.go` has no cleanup-related fields.

## Change
1. Add `CleanupEnabled`, `CleanupInactiveDays`, `CleanupBatchSize` to `server/config.go` with env var parsing.
2. Create `server/cleanup.go` with a `runCleanup(store S3Client, cfg Config, dryRun bool)` function implementing the algorithm from the ADR.
3. Wire it as either a goroutine on a 24h ticker (gated by `CleanupEnabled`) in `server/main.go`, or a CLI flag like `--cleanup` for one-shot runs.
4. Add tests in `server/cleanup_test.go` covering both policies and the batch-size limit.

## Verify
- `cd server && go test ./...` passes
- Test: create a user with no display_name, advance clock >7 days, cleanup deletes them
- Test: create a user with last_active >180 days ago, cleanup deletes them
- Test: dry-run mode logs but doesn't delete
