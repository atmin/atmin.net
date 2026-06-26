# Tasks

The **frontier** — active and upcoming work, one line each. A task earns a
`*.md` file when it's ready to implement; delete the file once it lands. What has
*shipped* is recorded in the diary, [docs/releases/](../docs/releases/) — keep
this file forward-looking, never a changelog.

- **[clear-local-state-on-auth](clear-local-state-on-auth.md)** — cross-account
  IndexedDB leak fixed: `saveSession` wipes on owner-mismatch (model (c)),
  closing the key leak too. Invariant I11 + e2e added. **Implemented, pending
  commit + real-device check.**
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

**Shipped:** v0.1 ([mvp-v0.1.md](../docs/specs/mvp-v0.1.md)) · v0.2 — the UI
revamp ([releases/v0.2.md](../docs/releases/v0.2.md)).
