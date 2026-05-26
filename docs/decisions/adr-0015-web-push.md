# ADR-0015: Web Push for background delivery

Status: Draft
Date: 2026-05-26

Builds on [ADR-0001](adr-0001-sync-first-s3-mailbox.md) (sync-first
philosophy: realtime is an optimization) and
[ADR-0004](adr-0004-sse-realtime-notifications.md) (SSE for
foreground delivery).

## Context

SSE delivers messages in real time while the app is open. When
the app is closed — browser tab killed, PWA backgrounded, phone
locked — there is no delivery: the next sync only happens when
the user re-opens the app. There is no badge, no notification,
no signal that something arrived. Every other modern messenger
has this; users expect it.

The natural fit is the [Web Push API](https://www.w3.org/TR/push-api/)
combined with the [Notifications API](https://notifications.spec.whatwg.org/)
and [App Badging](https://w3c.github.io/badging/). The service
worker already exists for SW-update notifications; extending it
with a `push` handler is the minimum incremental work.

The interesting question is *what* the push payload says. atmin.net
is end-to-end encrypted; the server has never seen plaintext
message bodies and we are not changing that. Two paths:

- **Generic notification** built server-side: title carries the
  sender's handle (which the server knows), body is empty.
  Service worker just calls `showNotification` and a badge bump.
- **Decrypt-in-SW**: server sends a minimal trigger; the SW
  reads Megolm session keys from IDB, fetches and decrypts the
  message, shows a preview-rich notification. Larger SW surface,
  WASM in the SW context.

v0.1 ships with generic-body notifications. This ADR records the
generic-only design plus all the simplifications it enables; the
decrypt-in-SW path is left as a separate future ADR if richer
previews become a real product need.

## Decision

### Trust model

Web Push routes through a per-browser push service: FCM for
Chrome / Android, Mozilla Autopush for Firefox, Apple's APNs
bridge for Safari / iOS. The push payload is encrypted between
the server and the user agent (RFC 8291), but **the push service
sees timing, device endpoint, and ciphertext size**.

The server constructs the payload, so the server sees what's in
the notification — `"New message from {handle}"` — and the
push service sees the encrypted bytes plus the metadata above.
This is the same trust model Signal, WhatsApp, and Matrix
clients accept when they use FCM/APNs. We accept it.

The Megolm session keys, the sharing private key, and the
backup encryption key remain on-device only. The SW does **not**
touch any of them in this design.

### Server-built generic notification

The payload is:

```jsonc
{
  "title": "New message from {handle}",
  "body":  "",
  "url":   "/@{handle}"
}
```

`{handle}` is resolved server-side from the message's `from_user`
(one extra read from `handles/{handle}.json`, cacheable). Including
the handle leaks "who messages whom" timing to the push service —
the same metadata the push service already infers from delivery
timing. Worth the UX win.

For the Saved Messages case (`from_user == to_user`), the title
is `"Saved Messages"` and no handle is included.

### Subscription storage

The push subscription returned by `pushManager.subscribe()` is
stored as a **new optional field on the existing device record**
at `users/{uid}/devices/{did}.json`:

```jsonc
{
  "device_id":    "01HWQA...",
  "device_label": "Alice's laptop",
  "created_at":   "2025-01-15T10:00:00Z",

  "push_subscription": {
    "endpoint":   "https://fcm.googleapis.com/fcm/send/...",
    "p256dh":     "<base64url>",
    "auth":       "<base64url>",
    "created_at": "2026-05-26T10:00:00Z"
  }
}
```

No new S3 prefix. No new lifecycle to track. The subscription
dies when the device record is revoked (existing
`POST /v1/devices/revoke` deletes the file). Dead push services
(410 from FCM/Mozilla/APNs) cause the server to lazily clear the
field via a `PUT` of the cleaned device.json.

### Endpoints

Three small additions:

- `GET /v1/push/vapid-public-key` — unauthenticated; returns the
  server's VAPID public key so the client can subscribe.
- `PUT /v1/devices/{device_id}/push` — authenticated (caller's
  own device only); stores or replaces the subscription.
- `DELETE /v1/devices/{device_id}/push` — authenticated;
  clears the subscription field.

### Delivery hook

The existing `POST /v1/send` handler ([handlers.go:339](../../server/handlers.go#L339))
ends with `hub.Notify(toUser, "new_message")`. Alongside that
notification, the server kicks a goroutine that:

1. Reads recipient's device records.
2. For each device with a `push_subscription`, builds the
   payload (resolves sender handle, formats title), and POSTs
   the encrypted push via `github.com/SherClockHolmes/webpush-go`.
3. Best-effort: failures are logged but never block `/v1/send`.
   `410 Gone` from the push service triggers lazy subscription
   clearance.

### Client-side dedup

The server does **not** track which devices are currently
SSE-connected. Push is fired to every subscribed device on
every message. The service worker handles the dedup:

```js
self.addEventListener('push', async (event) => {
    const data = event.data.json();
    const clients = await self.clients.matchAll({
        type: 'window',
        visibilityState: 'visible',
    });
    if (clients.length > 0) return; // app open + visible
    event.waitUntil(self.registration.showNotification(data.title, {
        body: data.body,
        tag:  data.url, // collapse per-conversation
        data: { url: data.url },
    }));
    // bump badge, persisted in IDB
});
```

If the app is open and visible, the notification is suppressed —
the in-app UI already shows the new message via SSE. If the app
is closed, backgrounded, or in another tab, the notification
fires.

### Badge

Local-per-device. Service worker bumps a count in IDB on every
displayed push, calls `navigator.setAppBadge(count)`. The main
app clears the badge on `visibilitychange` (when it becomes
visible) via `navigator.clearAppBadge()` and resets the IDB
count. No cross-device badge sync — each device's count drifts
independently, self-corrects on open.

### Subscription refresh

Browsers periodically rotate push subscriptions. The
`pushsubscriptionchange` event fires in the SW when this happens;
the SW re-subscribes and re-POSTs to `/v1/devices/{did}/push`.
Included in v1 — without it, notifications silently stop after
a few weeks for some users.

### VAPID keys

One keypair for the whole service. Generated once via
`webpush-go`'s helper, stored in env vars:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` (`mailto:` address per RFC 8292)

Public key fetched once on app load and cached client-side.

### iOS

iOS only supports Web Push for **installed** PWAs (Safari 16.4+).
[tasks/ios-install-hint](../../tasks/ios-install-hint.md) is
already in the queue and is the prerequisite for the iOS path.
For uninstalled Safari tabs the notification settings toggle is
visible but disabled, with copy pointing at the install hint
("Install atmin to enable notifications on iOS").

## Consequences

### Positive

- Closed-app delivery and home-screen badges, the two biggest
  background-delivery UX gaps closed.
- Service worker never touches Megolm keys or WASM — the SW
  security surface stays at its current minimum.
- No new S3 prefix; subscription rides on the device record.
- Server-side push send is best-effort and async; `/v1/send`
  latency is unaffected.

### Negative

- Push services (FCM/Mozilla/APNs) learn message timing per
  device and the sender's handle. Same trust model as
  Signal/WhatsApp via FCM/APNs; explicit so we don't sleepwalk
  into it.
- Stored push subscription endpoints couple the server's
  state to third-party infrastructure. FCM endpoint shape
  changes (rare but possible) would require migration.
- One new server dependency (`webpush-go`).
- Notification bodies are minimal ("New message from X"). If
  users want previews later, that's the decrypt-in-SW upgrade
  — its own ADR, larger SW surface.
- **Device-record race on `410 Gone`.** When the push service
  returns 410, `fanOutPush` clears `push_subscription` via a
  read-modify-write on `users/{uid}/devices/{did}.json`.
  Scaleway lacks conditional writes ([ops.md — Object storage
  constraints](../ops.md#object-storage-constraints)), so a
  concurrent `PUT /v1/devices/{did}/push` (e.g. from
  `pushsubscriptionchange`) racing with the clear can result in
  the fresh subscription being clobbered. The observable
  failure is "notifications appear to stop working until the
  user re-toggles the setting" — the same failure category as
  natural subscription expiry, and rare enough (sub-second
  window) that adding a per-device mutex isn't worth the
  complexity. Accepted; the SW's `pushsubscriptionchange`
  handler will re-post and recover.
- **Unbounded `fanOutPush` goroutines per send.** Each
  `/v1/send` spawns one goroutine per recipient device with a
  subscription. Bursty senders (a script sending many messages
  back-to-back) spawn many parallel push attempts against
  external services. Fine at v0.1 scale; if burst patterns
  show up in operations, a per-recipient semaphore is a small
  follow-up.

### Neutral

- The SW already exists for SW-update; this adds `push` and
  `notificationclick` event handlers. VitePWA's
  `injectManifest` strategy lets us write custom SW source
  while Workbox still handles precaching.
- Each device tracks its badge independently. Multi-device
  users see slightly stale counts on devices they haven't
  opened recently. Self-corrects on first open.

## Migration

Additive. Existing device records have no `push_subscription`
field; the server treats absent-or-empty as "no push for this
device." No data migration required.

## Alternatives considered

### Decrypt-in-SW (full-fidelity notifications)

Rejected for v0.1 in favour of the generic-body design above.
Cost is meaningful: WASM in SW context, Megolm key access from
SW, IDB read from SW, more failure modes (WASM load failures
inside a push event have short timeouts). The trade is a richer
notification body — not worth the complexity until richer
previews are a demonstrated product need.

### Subscription storage in a separate prefix

Rejected. `users/{uid}/devices/{did}.json` already exists, has
the right lifecycle (created on add-device, deleted on revoke),
and lives in the right authorization scope. A new
`push-subscriptions/{uid}/{did}.json` prefix would duplicate
this for no gain.

### Server-side delivery dedup (skip push when SSE is connected)

Rejected. Would require the server to track SSE-connection
state per device. The current `EventHub` is in-process; the
delivery hook is fire-and-forget. Adding a "is this device
connected?" gate moves us back toward the stateful-server model
[ADR-0001](adr-0001-sync-first-s3-mailbox.md) is trying to
avoid. Client-side dedup (`visibilityState`) is sufficient and
costs nothing server-side.

### Cross-device badge sync

Rejected. The mechanism (broadcast "I cleared the badge" to
sibling devices) requires either an extra SSE message type or
a server-side coordination primitive. The bug it would fix
(stale badge on Device B until Device B opens) is minor and
self-correcting. If it ever becomes a real complaint, a
sibling-device sync message is a small follow-up.

### Multiple VAPID keypairs per environment

Rejected. One pair per environment (staging vs. production) is
already implied by the env-var split; one pair *per service* is
the WebPush convention. Multiple pairs would only matter for a
multi-tenant deploy, which atmin.net is not.
