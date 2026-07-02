# I18 — The cleanup sweep deletes only what policy names

> Part of the [invariants index](./README.md). Priority **P2** — rarely run,
> but the highest per-run blast radius in the system.
> Spec: `web/e2e/invariants/cleanup-sweep.spec.ts` — not yet written.

**Statement.** A `cleanup` run (the arg-based subcommand, ADR-0006) against a
bucket holding live accounts deletes exactly the expired matter — abandoned
registrations past their grace, accounts inactive past
`CLEANUP_INACTIVE_DAYS`, handle tombstones past their 30-day cooldown — and
provably nothing reachable by an active account. After `--apply`, every
message, key blob, chain link, and media object of an active user is intact
**and still works end-to-end**: a fresh device decrypts full history, across a
rotation boundary. And an expired account is deleted *completely* — not the
first 1000 objects of each prefix, and not "profile gone, `keys/` orphaned".
Dry-run (the default) deletes nothing, ever.

Unit tests already cover the classifier (`server/src/cleanup.rs` takes an
injected `now`); what only an e2e proves is the blast-radius half against the
real S3 layout — that the sweep's prefix deletes carve exactly at account
boundaries, and that the surviving state still *functions*, not merely
exists.

**Known drift this spec surfaces, not assumes.** `idempotency.rs` documents a
24 h TTL on rotation records (`users/{uid}/rotation-records/`), but
`run_cleanup` has **no sweep for them** (verified: no reference to
rotation-records in `cleanup.rs`). So stale records accumulate on a live
account. This spec therefore asserts their *survival* today and carries a TODO
to flip to a deletion assertion once the sweep lands — it must not pretend a
sweep exists. Likewise, this covers only the offline `cleanup` subcommand: the
interactive `DELETE /v1/profile` handler is a *separate* wipe path that
(unlike `cleanup::delete_user`) does not paginate — its >1000-object and
mid-wipe-orphan behaviour is out of scope here and needs its own guard.

**Fault construction.** No clock control needed — expiry lives in the *data*,
which `putObject` can forge:

1. Build the protected world with real clients: Alice and Bob with history
   (live + archive), key backups, one credential rotation (so
   `key_chain.json` exists), media, and read-markers; plus a fresh
   half-registered account inside its abandonment grace, and a fresh deletion
   tombstone inside its cooldown.
2. Forge the expired world directly in S3: a profile whose `last_active` is
   far past the inactive threshold, and a handle tombstone stamped more than
   30 days ago. Also forge a rotation record older than 24 h — but to assert
   its *survival* (the sweep for it is unimplemented, see above), not its
   deletion.
3. From the e2e harness, run the server binary's `cleanup` subcommand with
   the suite's S3 env — first without `--apply` (dry run), then with.

**Assertions.**

- Dry run: the full-bucket key set is unchanged (zero deletes); the summary
  counts match the forged expired world.
- After `--apply`: the inactive account and the expired tombstone are gone,
  and the inactive account is gone *completely* — zero objects under any of
  its prefixes, not a truncated first page and not "profile deleted, `keys/`
  left behind" (the resumability half: a mid-wipe failure must leave the
  account still classifiable so the next run finishes it). The in-grace
  account, the in-cooldown tombstone, and the forged rotation record all
  survive (the last per the drift note above).
- Every prefix of Alice and Bob (`users/`, `inbox/`, `keys/`, `media/`) is
  untouched — same key set, same sizes.
- The working proof: a fresh device logs into Alice *after* the sweep and
  renders her complete history, including pre-rotation eras (the chain walk
  of [I9](./i9-chain-walker.md) still succeeds against the swept bucket).

**Permitted divergence.** None. A cleanup that deletes one reachable object
of an active account is a P0 incident; this spec is the rehearsal that keeps
it hypothetical.
