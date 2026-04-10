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

## Device attestation (deferred)

When PoW + Turnstile ([ADR-0007](../decisions/adr-0007-registration-abuse-prevention.md))
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
