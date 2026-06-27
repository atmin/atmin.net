# Native apps (Capacitor)

v0.1 is browser-first. Native apps become valuable when the system needs
capabilities that browsers cannot provide: address book access for contact
discovery and background push notifications. (Device attestation was a third
candidate, but the registration proof-of-work in
[ADR-0020](../decisions/adr-0020-registration-proof-of-work.md) already covers the
anti-abuse need — see below.)

## Why Capacitor

The main app stays TypeScript and runs in a webview. Capacitor wraps it in a
thin native shell — the web build is the app, native APIs are accessed through
plugins called from TypeScript. Alternatives considered:

- **React Native** — requires rewriting the UI in RN components. Defeats the
  purpose of keeping the web app.
- **Tauri Mobile** — stable since Tauri 2.0 (Oct 2024), but the mobile developer
  experience still lags desktop and not all official plugins support mobile yet
  (smaller mobile plugin ecosystem).<sup>[1](#sources)</sup>
- **Raw Kotlin/Swift wrappers** — rebuilds what Capacitor already provides.
- **PWA-only** — no contact access on iOS,<sup>[2](#sources)</sup> no attestation, no store presence.

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
the interval by engagement/battery to roughly **once every ~12 hours**<sup>[3](#sources)</sup> — never the
per-minute cadence timely delivery needs. On iOS specifically there is *no*
background web execution mechanism at all: the sole background wake-up is Web Push,
and Apple requires a push that wakes the worker to surface a **visible
notification** (no silent badge-only poll).<sup>[4](#sources)</sup> So background polling cannot substitute
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
  aggressive OEM task-killers — the `dontkillmyapp` problem),<sup>[5](#sources)</sup> and
  Play-Store friction (F-Droid / sideload is the natural home for non-FCM push).
  Existing FOSS messengers ship one of three *distinct* mechanisms here, not a single
  shared one: **Molly** self-hosts UnifiedPush via MollySocket; **Conversations** is
  itself a UnifiedPush distributor over its XMPP connection; **Signal** without Google
  Play Services (and Molly-FOSS without UnifiedPush) falls back to a persistent
  websocket keepalive; **Briar** runs an always-on foreground service syncing over Tor
  with no push server at all.<sup>[6](#sources)</sup>
- **iOS:** **APNs is unavoidable** for waking a backgrounded/killed app — iOS allows
  no persistent background socket. A native app uses APNs *directly* (no browser
  web-push relay). The payload carries **no message plaintext** — the app fetches and
  decrypts the E2E envelope locally and only then surfaces the notification, limiting
  Apple to timing/size metadata, never content. The *reliable* form of this on iOS is
  a user-visible **alert** push processed by a Notification Service Extension that
  rewrites the notification with the decrypted content; truly silent
  (`content-available`) background pushes are aggressively throttled and dropped on
  force-quit / Low Power Mode, so they are not a dependable wake mechanism. This is the
  Signal pattern,<sup>[7](#sources)</sup> and the irreducible third-party: Apple owns iOS
  background delivery by design.

Where a vendor is unavoidable the payload stays a content-free trigger — keys and
plaintext never leave the device, consistent with the E2E / no-PII design. A dedicated
ADR records the chosen per-platform mechanism when push is implemented.

## Device attestation (reference — not pursued)

Device attestation was considered as the next anti-abuse layer — a
proof-of-device-ownership signal to cap registrations per physical device. That
need is **already met** by the memory-hard Argon2id registration proof-of-work
([ADR-0020](../decisions/adr-0020-registration-proof-of-work.md)), so attestation is
**not being pursued**. This section stays only as a reference for the mechanisms and
their limits.

- **iOS**: App Attest — a key bound to the Secure Enclave and attested by Apple. The
  key is **per-app-installation and anonymous** — it carries no hardware identifiers
  and is regenerated on reinstall / device restore, so it is not a device
  fingerprint.<sup>[8](#sources)</sup>
- **Android**: Play Integrity — a signed (and, on standard requests, Google-encrypted)
  verdict on device and app integrity.<sup>[9](#sources)</sup>

Neither primitive yields a stable per-physical-device identifier — App Attest keys are
per-installation, and the Play Integrity token carries no hardware ID — so neither can
directly anchor "N accounts per physical device." The durable per-device side-channels
that *can* approximate it are Apple **DeviceCheck** (two per-device bits that persist
across reinstall) and Google Play Integrity **device recall** (per-device bits stored on
Google's servers) — but device recall's terms permit only abuse mitigation and **forbid
using it to fingerprint or track devices**.<sup>[10](#sources)</sup> This is coarse abuse-state, not
an opaque device ID, and it reveals nothing about the user.

A Capacitor bridge would be needed, but not a from-scratch plugin — maintained community
plugins already wrap both primitives (e.g. `@capgo/capacitor-app-attest` covers App
Attest on iOS and Play Integrity on Android).<sup>[11](#sources)</sup> Distribution
matters: on iOS, App Attest works only for apps shipped through Apple's official channels
(App Store, TestFlight, enterprise/custom, and EU notarized builds), not arbitrary
sideloaded binaries. On Android, `deviceIntegrity` is evaluated even for sideloaded apps,
but the Play-tied signals — `appRecognitionVerdict` (which returns `UNRECOGNIZED_VERSION`
for sideloads) and the licensing verdict — require Google Play distribution to be
meaningful.

## Distribution

- **App Store** (iOS): Apple Developer Program, $99/year. The **App Store Small
  Business Program** gives 15% commission (instead of 30%) for up to $1M USD in
  *proceeds* (net, prior calendar year).<sup>[12](#sources)</sup>
- **Play Store** (Android): $25 one-time registration fee.
- **EU alternative distribution**: the DMA allows Apple-authorized alternative
  marketplaces and direct web distribution on iOS. Web Distribution is gated to
  large/established publishers (EU-incorporated org, 2+ years in the Developer Program
  in good standing, and >1M EU first-annual installs in the prior year). Android has
  always allowed sideloading. Note: Apple's EU terms are mid-transition — the
  per-install Core Technology Fee is being replaced by a 5% **Core Technology
  Commission** on digital-goods revenue across all channels (targeted for 1 Jan 2026,
  still contested with the European Commission).<sup>[13](#sources)</sup> Not practical at launch —
  store presence provides user trust and auto-updates.

**Web → app routing.** iOS web visitors who land on the URL are pointed to the
App Store listing via Apple's Smart App Banner (a `<meta name="apple-itunes-app">`
tag). Android has no `<meta>`-tag equivalent — the closest is the Web App Manifest's
`related_applications` / `prefer_related_applications`, which trigger Chrome's
native-app install banner (Chrome-only, and it *supplants* the PWA install prompt
rather than coexisting).<sup>[14](#sources)</sup> This supersedes the earlier PWA "Add to
Home Screen" install hint (dropped): the native app is the iOS install path. An
installed iOS PWA *can* receive Web Push (delivered via APNs since iOS 16.4), but only
with a mandatory **visible notification** on every push — it gets no silent
content-free background push and no background fetch, so it cannot wake, pull an E2E
message, and update state silently. A native app *can* use silent `content-available`
pushes and background fetch, which is the real background-delivery advantage<sup>[4](#sources)</sup> —
so promoting the PWA was promoting the weaker experience. The banner is a thin
web-side addition, not a native-build concern, and lights up only once the store
listings exist.

## Monetization outside app stores

Storage beyond the free quota can be sold through the project's own website (e.g.,
via Stripe), with the server activating the purchased quota against the account. This
maps onto Apple's **Guideline 3.1.3(f) ("Free Stand-alone Apps")**, which explicitly
lists *Cloud Storage* and lets a free companion app to a paid web service skip in-app
purchase — **provided there is no purchasing inside the app and no in-app
call-to-action to buy on the website**.<sup>[15](#sources)</sup> Stay inside those
conditions and it is a recognized path, not the contested 3.1.1 ("you must use IAP to
unlock features") zone.

Two caveats on "avoiding commissions *entirely*". The 2025 Epic v. Apple injunction
(contempt affirmed Dec 2025) relaxed anti-steering so US-storefront apps may now link
out to external purchase with a neutral disclosure and, currently, no Apple commission
— but that relief is US-only and did not remove the underlying IAP requirement.<sup>[16](#sources)</sup>
In the EU, developers may steer to external purchases, but Apple's 5% Core Technology
Commission can attach to external digital-goods sales (a clean 3.1.3(f) posture with no
actionable in-app link largely sidesteps it). So commissions are avoided under the
stand-alone-app pattern, but "entirely" holds only if the app never links to or prompts
the purchase.

## Implementation order

1. Add Capacitor, configure build pipeline.
2. Generate iOS Xcode project + Android Studio project.
3. On-device testing with live reload.
4. Contacts access plugin + privacy-preserving discovery protocol (ADR).
5. Store enrollment and publishing.

(Device attestation is intentionally absent — the Argon2id registration proof-of-work
covers the anti-abuse need; see "Device attestation" above.)

## Sources

1. Tauri 2.0 release — stable mobile, Oct 2024: <https://v2.tauri.app/blog/tauri-20/> · mobile plugin support: <https://v2.tauri.app/develop/plugins/develop-mobile/>
2. Contact Picker API — unsupported in Safari/iOS: <https://caniuse.com/wf-contact-picker> · <https://developer.mozilla.org/en-US/docs/Web/API/Contact_Picker_API>
3. Periodic Background Sync — Chromium-only support: <https://caniuse.com/wf-periodic-background-sync> · ~12h throttle: <https://developer.chrome.com/docs/capabilities/periodic-background-sync>
4. Web Push for web apps on iOS/iPadOS (16.4+, via APNs, mandatory visible notification): <https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/> · <https://webkit.org/blog/12945/meet-web-push/> · <https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers>
5. Don't kill my app! — Doze + OEM background-task killers: <https://dontkillmyapp.com/>
6. MollySocket (UnifiedPush via a Signal linked device): <https://github.com/mollyim/mollysocket> · Conversations as a UnifiedPush distributor: <https://unifiedpush.org/users/distributors/conversations/> · Signal-FOSS websocket keepalive: <https://www.twinhelix.com/apps/signal-foss/> · Briar foreground service: <https://f-droid.org/packages/org.briarproject.briar.android/>
7. Signal-iOS Notification Service Extension: <https://github.com/signalapp/Signal-iOS/blob/main/SignalNSE/NotificationService.swift> · silent (content-available) push limits: <https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app>
8. App Attest — establishing app integrity: <https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity> · WWDC21 session: <https://developer.apple.com/videos/play/wwdc2021/10244/>
9. Play Integrity — verdicts: <https://developer.android.com/google/play/integrity/verdicts> · overview: <https://developer.android.com/google/play/integrity/overview>
10. Play Integrity device recall (per-device bits; fingerprinting forbidden): <https://developer.android.com/google/play/integrity/device-recall> · DeviceCheck / App Attest limits: <https://approov.io/blog/limitations-of-apple-devicecheck-and-apple-app-attest>
11. @capgo/capacitor-app-attest: <https://github.com/Cap-go/capacitor-app-attest> · capacitor-community/play-integrity: <https://github.com/capacitor-community/play-integrity>
12. App Store Small Business Program: <https://developer.apple.com/app-store/small-business-program/>
13. Apple — DMA and apps in the EU: <https://developer.apple.com/support/dma-and-apps-in-the-eu/> · Web Distribution eligibility: <https://developer.apple.com/support/web-distribution-eu/>
14. Smart App Banners: <https://developer.apple.com/documentation/webkit/promoting-apps-with-smart-app-banners> · Android native-app install banner (`related_applications`): <https://developer.chrome.com/blog/app-install-banners-native>
15. App Store Review Guidelines (3.1.1, 3.1.3(b), 3.1.3(f)): <https://developer.apple.com/app-store/review/guidelines/>
16. Epic v. Apple — Ninth Circuit affirms contempt; external-link commission (Dec 2025): <https://www.macrumors.com/2025/12/11/apple-app-store-fees-external-payment-links/> · <https://en.wikipedia.org/wiki/Epic_Games_v._Apple>
