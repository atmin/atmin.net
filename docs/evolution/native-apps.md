# Native apps (Capacitor)

v0.1 is browser-first. Native apps become valuable when the system needs
capabilities that browsers cannot provide: address book access for contact
discovery, device attestation for abuse prevention, and push notifications.

## Why Capacitor

The main app stays TypeScript and runs in a webview. Capacitor wraps it in a
thin native shell — the web build is the app, native APIs are accessed through
plugins called from TypeScript. Alternatives considered:

- **React Native** — requires rewriting the UI in RN components. Defeats the
  purpose of keeping the web app.
- **Tauri Mobile** — immature on mobile, smaller plugin ecosystem.
- **Raw Kotlin/Swift wrappers** — rebuilds what Capacitor already provides.
- **PWA-only** — no contact access on iOS, no attestation, no store presence.

## Development workflow

1. Develop and iterate in the browser (fastest feedback loop).
2. `npx cap sync` copies the web build + plugins into native projects.
3. `npx cap open ios` / `npx cap open android` opens Xcode / Android Studio.
4. Run on physical device from the IDE. Live reload supported (webview points
   at dev server IP).

## Contact discovery

Native apps can read the device address book (with user permission). This
enables privacy-preserving contact discovery:

- Client hashes phone numbers locally before sending to the server.
- Server matches hashes against an index of opted-in users.
- Server never sees plaintext phone numbers.

Ties into [discovery and identity](./discovery-and-identity.md).
Protocol design warrants its own ADR when implementation begins.

## Push notifications

Background delivery (app closed/backgrounded) is the main reason Web Push was
considered ([ADR-0015](../decisions/adr-0015-web-push.md) — **not pursued**). Native
apps deliver it with a smaller third-party surface. Push is *only* the
background-wake-up; foreground delivery stays on SSE
([ADR-0004](../decisions/adr-0004-sse-realtime-notifications.md)) with no vendor.

**Why not poll from a PWA service worker instead (avoiding push entirely)?**
Considered and ruled out. A service worker can't run a background timer — it's
event-driven and killed when idle, so a `setInterval` stops the moment the app is
backgrounded. The only API for scheduled wake-ups is **Periodic Background Sync**,
and it fails on two counts: it's **Chromium-only** (absent in WebKit, so it does
not exist on an installed iOS web app), and where it does run the browser throttles
the interval by engagement/battery to roughly **once every ~12 hours** — never the
per-minute cadence timely delivery needs. On iOS specifically there is *no*
background web execution mechanism at all: the sole background wake-up is Web Push,
and Apple requires a push that wakes the worker to surface a **visible
notification** (no silent badge-only poll). So background polling cannot substitute
for push, and on iOS the only background path is APNs — which is why timely
background delivery is inherently a native capability, not a PWA one. (Periodic
Background Sync remains usable on Android/desktop Chrome for *low-urgency* ~12-hour
refresh, but that is not message delivery.)

The "notify only when there are messages" outcome *is* reachable — but as
**event-driven push, not periodic poll-and-suppress**: the conditional moves to
*when the server chooses to send* (a wake-up only when a message lands → worker
fetches → shows the notification; no message → no push → nothing), because a worker
that receives a push **cannot** stay silent (iOS shows a system notification or
revokes the subscription otherwise). That is strictly the Web Push path above —
permission prompt + a visible notification per delivered message — viable if made
**opt-in**, but a decision deferred with the rest of background delivery, not a way
to avoid push.

- **Desktop (Tauri):** no vendor — keep the SSE connection alive and raise OS
  notifications locally.
- **Android:** the vendor is optional. A foreground-service persistent connection, or
  self-hosted **UnifiedPush** (e.g. an `ntfy` distributor on Scaleway), keeps push
  in-house and EU-resident; **FCM** is the low-effort fallback. Trade-offs: battery
  (persistent connection + the "app is running" notification), reliability (Doze and
  aggressive OEM task-killers — the `dontkillmyapp` problem), and Play-Store friction
  (F-Droid / sideload is the natural home for non-FCM push). Signal-FOSS, Molly,
  Briar, and Conversations all ship this.
- **iOS:** **APNs is unavoidable** for waking a backgrounded/killed app — iOS allows
  no persistent background socket. A native app uses APNs *directly* (no browser
  web-push relay), and a **content-free wake-up** payload (the push says only "wake
  up"; the app then pulls the E2E message from the server) limits Apple to timing/size
  metadata, never content. This is the Signal pattern, and the irreducible
  third-party: Apple owns iOS background delivery by design.

Where a vendor is unavoidable the payload stays a content-free trigger — keys and
plaintext never leave the device, consistent with the E2E / no-PII design. A dedicated
ADR records the chosen per-platform mechanism when push is implemented.

## Device attestation (deferred)

When the registration proof-of-work ([ADR-0020](../decisions/adr-0020-registration-proof-of-work.md))
proves insufficient, device attestation is the next layer:

- **iOS**: App Attest — hardware-bound key in Secure Enclave, verified with Apple.
- **Android**: Play Integrity — signed verdict on device and app integrity.

Both produce an opaque device ID the server can use to enforce registration
limits (e.g., 1-3 accounts per physical device). The ID reveals nothing about
the user — less identifying than the user_id already issued.

Custom Capacitor plugins required (~50-100 lines Swift and Kotlin each).
Attestation works regardless of distribution channel on iOS; on Android,
Play Integrity's app verdict is stronger for Play Store installs but device
integrity works for sideloaded apps too.

## Distribution

- **App Store** (iOS): Apple Developer Program, $99/year. Small Developer
  Program gives 15% commission (instead of 30%) under $1M revenue.
- **Play Store** (Android): $25 one-time registration fee.
- **EU alternative distribution**: DMA allows alternative marketplaces and
  (for large publishers) direct web distribution on iOS. Android has always
  allowed sideloading. Not practical at launch — store presence provides user
  trust and auto-updates.

**Web → app routing.** iOS web visitors who land on the URL are pointed to the
App Store listing via Apple's Smart App Banner (a `<meta name="apple-itunes-app">`
tag), and Android visitors can be linked to the Play listing similarly. This
supersedes the earlier PWA "Add to Home Screen" install hint (dropped): the
native app is the iOS install path, and an installed iOS PWA still cannot
receive APNs background push, so promoting it was promoting the weaker
experience. The banner is a thin web-side addition, not a native-build concern,
and lights up only once the store listings exist.

## Monetization outside app stores

Features like storage beyond a free quota can be sold through the project's
own website (e.g., via Stripe or similar), avoiding app store commissions
entirely. The app is a free download; payments happen outside the stores;
the server activates the purchased quota against the user's account.

## Implementation order

1. Add Capacitor, configure build pipeline.
2. Generate iOS Xcode project + Android Studio project.
3. On-device testing with live reload.
4. Contacts access plugin + privacy-preserving discovery protocol (ADR).
5. Store enrollment and publishing.
6. Device attestation — when needed, not before.
