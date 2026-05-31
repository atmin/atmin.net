package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"
)

// Data-retention cleanup (ADR-0006). A single idempotent routine that sweeps
// two categories of dead data:
//
//   - Abandoned registrations: no display_name AND no messages, older than the
//     7-day grace period. Likely test accounts or abandoned signups.
//   - Inactive users: last_active older than the configured threshold.
//
// Designed to run from the `cleanup` subcommand on a schedule (Scaleway
// Serverless Job + cron — see docs/ops.md), not in-process: the server is
// stateless and only one instance should sweep.

// abandonedGrace is the fixed window after registration before an abandoned
// account is eligible for deletion (ADR-0006). Only the inactive threshold is
// configurable.
const abandonedGrace = 7 * 24 * time.Hour

// handlesPageSize bounds a single ListObjects page over handles/.
const handlesPageSize = 1000

type CleanupOpts struct {
	InactiveDays int
	BatchSize    int              // max users deleted per run (caps deletes, not scans)
	DryRun       bool             // true = log matches only, delete nothing
	Now          func() time.Time // injectable for tests; nil → time.Now
}

type CleanupResult struct {
	HandlesScanned int
	Abandoned      int
	Inactive       int
	Tombstones     int // expired handle tombstones swept (ADR-0013)
	Deleted        int // actual deletions, or would-be deletions under DryRun
	Errors         int
}

func runCleanup(ctx context.Context, store Store, opts CleanupOpts) (CleanupResult, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	var res CleanupResult
	cursor := ""
	for res.Deleted < opts.BatchSize {
		keys, next, err := store.ListObjects(ctx, "handles/", handlesPageSize, cursor)
		if err != nil {
			return res, err
		}
		for _, k := range keys {
			res.HandlesScanned++
			if res.Deleted >= opts.BatchSize {
				break
			}
			policy, p, err := evaluateUser(ctx, store, k, opts)
			if err != nil {
				res.Errors++
				slog.Warn("cleanup evaluate failed", "handle_key", k, "err", err)
				continue
			}
			if policy == "" {
				continue
			}
			switch policy {
			case "abandoned":
				res.Abandoned++
			case "inactive":
				res.Inactive++
			case "tombstone":
				res.Tombstones++
			}
			uid := ""
			if p != nil {
				uid = p.UserID
			}
			slog.Info("cleanup match",
				"user_id", uid, "handle_key", k, "policy", policy, "dry_run", opts.DryRun)
			if !opts.DryRun {
				// Tombstones are just the handle file; users are a full wipe.
				var derr error
				if policy == "tombstone" {
					derr = store.DeleteObject(ctx, k)
				} else {
					derr = deleteUser(ctx, store, p)
				}
				if derr != nil {
					res.Errors++
					slog.Warn("cleanup delete failed", "handle_key", k, "user_id", uid, "err", derr)
					continue
				}
			}
			res.Deleted++
		}
		if next == "" {
			break
		}
		cursor = next
	}
	return res, nil
}

// evaluateUser returns "abandoned", "inactive", or "" (keep) for one handle
// file. Tombstones (handle reserved post-deletion, no user_id) and handles
// pointing at a missing profile are kept — out of scope for this routine.
func evaluateUser(ctx context.Context, store Store, handleKey string, opts CleanupOpts) (string, *Profile, error) {
	data, err := store.GetObject(ctx, handleKey)
	if err != nil {
		return "", nil, err
	}
	var h publicHandleData
	if err := json.Unmarshal(data, &h); err != nil {
		return "", nil, err
	}

	now := opts.Now()

	if h.UserID == "" {
		// Tombstone (ADR-0013 post-deletion reservation). Once past the
		// cooldown it's claimable and the file is dead weight — sweep it.
		// A malformed/empty tombstone (no released_at) is left alone.
		if h.ReleasedAt == "" {
			return "", nil, nil
		}
		released, err := time.Parse(time.RFC3339, h.ReleasedAt)
		if err != nil {
			return "", nil, err
		}
		if now.Sub(released) > handleCooldown {
			return "tombstone", nil, nil
		}
		return "", nil, nil
	}

	p, err := getProfile(ctx, store, h.UserID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			// Dangling handle → missing profile. Leave it; not a retention
			// policy match.
			return "", nil, nil
		}
		return "", nil, err
	}

	// Abandoned: no display_name, no messages, past the grace period. Checked
	// first — it catches never-active signups whose last_active is empty.
	if p.DisplayName == "" {
		created, err := time.Parse(time.RFC3339, p.CreatedAt)
		if err == nil && now.Sub(created) > abandonedGrace {
			empty, err := inboxEmpty(ctx, store, h.UserID)
			if err != nil {
				return "", nil, err
			}
			if empty {
				return "abandoned", p, nil
			}
		}
	}

	// Inactive: once active, but silent for longer than the threshold.
	if p.LastActive != "" {
		last, err := time.Parse(time.RFC3339, p.LastActive)
		if err == nil &&
			now.Sub(last) > time.Duration(opts.InactiveDays)*24*time.Hour {
			return "inactive", p, nil
		}
	}

	return "", p, nil
}

// inboxEmpty reports whether the user has no live and no archived messages.
func inboxEmpty(ctx context.Context, store Store, uid string) (bool, error) {
	for _, prefix := range []string{prefixInboxLive(uid), prefixInboxArchive(uid)} {
		keys, _, err := store.ListObjects(ctx, prefix, 1, "")
		if err != nil {
			return false, err
		}
		if len(keys) > 0 {
			return false, nil
		}
	}
	return true, nil
}

// deleteUser removes everything for a user: all objects under users/{uid}/,
// inbox/{uid}/, keys/{uid}/, media/{uid}/, plus the handles/{handle}.json file.
// Idempotent — a second run lists nothing and the handle is already gone.
func deleteUser(ctx context.Context, store Store, p *Profile) error {
	for _, prefix := range []string{
		prefixUser(p.UserID),
		prefixInbox(p.UserID),
		prefixKeys(p.UserID),
		prefixMedia(p.UserID),
	} {
		for {
			keys, _, err := store.ListObjects(ctx, prefix, 1000, "")
			if err != nil {
				return err
			}
			if len(keys) == 0 {
				break
			}
			if err := store.DeleteObjects(ctx, keys); err != nil {
				return err
			}
			if len(keys) < 1000 {
				break
			}
		}
	}
	if p.Handle != "" {
		if err := store.DeleteObject(ctx, keyHandle(p.Handle)); err != nil {
			return err
		}
	}
	return nil
}
