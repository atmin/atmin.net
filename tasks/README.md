# Tasks

Active implementation tasks in priority order. Delete a file once its change lands.

1. **[scroll-to-bottom](scroll-to-bottom.md)** — Open chats at the newest message and anchor to the bottom when new messages arrive; show an unobtrusive "jump to latest" indicator when the user has scrolled up. Today the chat view opens at the oldest message — broken behaviour for a messenger and a prerequisite for any virtualization work.

2. **[server-cleanup-routine](server-cleanup-routine.md)** — Automated S3 cleanup for inactive and abandoned accounts. The `last_active` tracking prerequisite is already in place; this is the production-health item most at risk of being deferred indefinitely.

3. **[draft-persist](draft-persist.md)** — Persist unsent message drafts to localStorage across reloads. Small and self-contained; also unblocks the SW update path in `SWUpdateToast`, which suppresses auto-reload while a draft exists but has nothing to check yet.

4. **[ios-install-hint](ios-install-hint.md)** — Dismissible banner on iOS Safari pointing users toward "Add to Home Screen." Low effort; iOS has no native install prompt so without this the PWA is effectively undiscoverable on the platform.

5. **[storage-indicator](storage-indicator.md)** — `GET /v1/store/usage` endpoint backed by the existing quota cache, surfaced as a "X MB / 1 GB" line in settings with a warning at 90%. Straightforward now that media upload has landed and the quota infrastructure is in place.

6. **[message-virtualization](message-virtualization.md)** — Replace the message list with `@tanstack/react-virtual`. Park until there is evidence of real perf degradation; the plain map is fine at current message volumes. Depends on `scroll-to-bottom` landing first.
