# Tasks

The **frontier** — active and upcoming work, one line each. A task earns a
`*.md` file when it's ready to implement; delete the file once it lands. What has
*shipped* is recorded in the diary, [docs/releases/](../docs/releases/) — keep
this file forward-looking, never a changelog.

- **[remember-me-session-expiry](remember-me-session-expiry.md)** — "Remember
  me" checkbox + idle session expiry (30d / 1h, checked-by-default). Needs an
  ADR: the token never expires server-side, so client expiry is UX. **Follow-on
  to the leak fix.**
- **Group chats** — membership + rekey (Megolm is already a group ratchet);
  needs an ADR, **v0.3**. Pairs with
  [ADR-0024](../docs/decisions/adr-0024-chat-url-fragments.md) (fragment rooms).
- **Media Phase 2 — albums** — `attachments[]` clean break, multi-select
  composer; **v0.3**, not yet tasked.
- **History export / import** — client-side; export likely, import open;
  **v0.3**, not yet tasked.
- **Extended theming** — beyond light/dark on the existing token set; **v0.3**,
  not yet tasked.
- **[message-virtualization](message-virtualization.md)** — `@tanstack/react-virtual`;
  **parked** until there's evidence of real perf degradation.
- **Data-router transitions** — `createBrowserRouter` for RR-native back/link
  motion; **parked**, take up only if the gap is felt
  ([ADR-0023](../docs/decisions/adr-0023-konsta-ui.md)).

## Resilience & security (from the 2026-07 audit)

Actionable residue of a whole-repo resilience audit, grouped by the shared root
causes it identified (fix a root cause, several findings die together). Ordered
by blast radius.

- **[paginated-prefix-wipe](paginated-prefix-wipe.md)** — **High.** One shared
  drain-loop wipe + chunked `delete_objects` → fixes deletion orphaning,
  compaction wedge, cleanup mid-wipe. Ships I18.
- **[account-lifecycle-serialization](account-lifecycle-serialization.md)** —
  **High.** One per-uid lock + resumable delete + inbox-orphan sweep → fixes
  rotate-resurrects-deleted, permanent handle lockout, post-deletion orphans.
- **[harden-sender-controlled-fields](harden-sender-controlled-fields.md)** —
  **High.** Clamp `sent_at` at ingest (permanent read-marker poisoning) +
  validate `send` object names. Ships I14.
- **[pin-single-instance-scale](pin-single-instance-scale.md)** — **High.**
  `max-scale=1` is a correctness invariant but is neither documented nor
  enforced; verify + pin it in deploy.
- **abuse-controls** *(no task doc yet — needs ADR-0021 finalized)* — rate
  limiting (register/PoW, `send`, resolve) + per-user SSE connection cap +
  per-recipient inbox ceiling + `spawn_blocking` for Argon2 + an unconditional
  per-object presign size ceiling and quota accounting for the non-media
  client-writable prefixes (`keys/`, `contacts.json`, `read-markers.json`),
  which currently bypass both (H6). Folds in L6 (align presign-TTL ≤
  quota-cache-TTL) and the residual auth-proof replay guard (L3): a single-use
  server nonce or seen-signature TTL cache for add/revoke-device proofs — the
  one-sided freshness window is in place, but the ≤5-min replay window is not
  yet closed. L9 (unreverted quota reservation) **deferred** — documented
  single-instance tradeoff.
- **[sse-resilience](sse-resilience.md)** — **Medium.** Auto-reconnect +
  visibility/focus reconcile + tear down a revoked device's open stream.
- **[live-sync-cursor-robustness](live-sync-cursor-robustness.md)** — **Medium.**
  Full-list the live prefix + dedup so a below-cursor message isn't stranded.
- **[harden-under-asserting-invariants](harden-under-asserting-invariants.md)** —
  **Medium** (test-only, high leverage). Several invariant e2e tests assert less
  than their doc promises; a fail-everything impl passes them. Also writes I17.
- **spec-code-drift** *(no task doc yet — doc cleanup)* — undocumented `DELETE
  /v1/devices`; rotate-keys `rotation_unavailable` vs actual `409 {current:-1}`;
  error-table 503/`pow_invalid` gaps; ignored `store/list` `limit`; "25 MB" vs
  MiB; scenario docs referencing stale Go-style paths.
- **transparent-rotation-recovery** *(no task doc yet — Low)* — on a
  lost-response `rotate-keys` retry, recover in place when
  `KeyVersionStaleError.current` equals the attempted `key_version` instead of
  hard-logout (L1). The current legible re-auth path (re-login with the new
  password) is invariant-permitted, so this is UX polish, not correctness.

**Shipped:** v0.1 ([mvp-v0.1.md](../docs/specs/mvp-v0.1.md)) · v0.2 — the UI
revamp ([releases/v0.2.md](../docs/releases/v0.2.md)).
