# ADR-0009 — Native wrapper strategy: Tauri (desktop) + Capacitor (mobile)

**Date:** 2026-04-14 / updated 2026-04-15  
**Status:** Accepted — Tauri (desktop) + Capacitor (mobile)  
**Supersedes:** `docs/evolution/native-apps.md` (Capacitor-only)  
**Spike branch:** `tauri-spike` — contains `src-tauri/`, the generated Xcode project
(`src-tauri/gen/apple/`), and all Tauri build artifacts. Only this ADR is merged to
`master`; check out `tauri-spike` to resume investigation. Also, remove src-tauri from .gitignore!

---

## Context

The prior native-apps doc selected Capacitor for iOS/Android and left desktop unaddressed. A
spike (2026-04-14) re-evaluated Tauri v2 (released October 2024) as a unified wrapper covering
iOS, Android, macOS, and Windows from a single codebase — one native bridge, one plugin API,
no Electron.

The app is a React 19 + Vite SPA (`web/`) with two crypto layers: Web Crypto API and a Rust
WASM module (`web/crypto/`) providing Megolm group encryption, bundled into `web/dist/` by Vite.

---

## Spike results

### Q1 — iOS (simulator)

Tested on iPhone 17 simulator (iOS 26.4) and iPhone 16 simulator (iOS 18.6), Xcode 26.4.
The Tauri iOS project was generated with `cargo tauri ios init`, prerequisites: full Xcode,
CocoaPods, `rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios`.
Minimum deployment target: iOS 14.0 (bumped from 13 in Tauri PR #13997, merged Aug 2025).

**App boots, SPA loads, routing works.** The login screen renders correctly in the simulator.

**Login could not be completed due to a WKWebView HTTP POST body limitation:** when a Tauri
app registers a custom URL scheme handler (`tauri://`), WKWebView silently drops HTTP POST
request bodies for `http://localhost` requests — Content-Length is absent and the body arrives
as 0 bytes at the server. This affects both `fetch()` and `XMLHttpRequest`. Confirmed on iOS
18.6 (stable) and iOS 26.4 (pre-release). `curl` from the host to the same endpoint receives
the body correctly. Adding `NSAllowsLocalNetworking` to Info.plist did not resolve it.

This is a **dev environment limitation only**. Production apps communicate over HTTPS to a
real server; HTTPS POST bodies are not affected by this restriction. The dev workflow fix is
to use a local HTTPS server (e.g. mkcert + a TLS-terminating proxy in front of the Go server)
or to test login against a deployed staging environment. Physical device testing on a real
device against a staging server remains a prerequisite before shipping.

iOS build commands:
```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
brew install cocoapods
cargo tauri ios init       # one-time: generates src-tauri/gen/apple/
cargo tauri ios dev "iPhone 17"
```

### Q2 — Android (physical device)

Not tested. Android build requires: Android Studio, Android SDK + NDK (side by side), four
Rust targets (`aarch64-linux-android armv7-linux-androideabi i686-linux-android
x86_64-linux-android`), `ANDROID_HOME` and `NDK_HOME` set. Then: `cargo tauri android build`.

### Q3 — WASM in system webview

**macOS (WKWebView): confirmed working.** The app was run in dev mode; login, message
retrieval, and send all succeeded. These operations exercise Megolm WASM decryption and
encryption end-to-end — WASM runs in WKWebView without any special configuration, and no
COOP/COEP headers were required.

**iOS (WKWebView):** Could not be verified end-to-end — login was blocked by the iOS 26
simulator POST body bug (see Q1). WASM is supported in WKWebView from iOS 14+; Tauri's
minimum deployment target is iOS 14.0, so all supported devices should have WASM support.
Requires re-verification on a real device or stable iOS simulator.

**Android System WebView:** WASM is supported from Chrome/WebView 57 (Android 5.0). Tauri
requires Android 7+ (API 24, WebView 55+). Devices at the minimum (API 24, WebView 55) are
below WASM threshold by two releases; the practical floor is Android 7.1+ / WebView 57+.
Market share of Android 7.0 (API 24 exact) is <1% globally as of 2025. Not a meaningful
exclusion.

### Q4 — macOS tray panel

**Confirmed working.** Scaffold: `tauri-plugin-positioner` v2 + tray icon in `tauri.conf.json`,
frameless 390×780 window hidden at startup, `on_tray_icon_event` left-click toggles
show/hide, `window.move_window(Position::TrayCenter)` before show.

Observed behaviour: tray icon appears in menu bar, window shows/hides on click, positioned
correctly near tray icon. SSE real-time delivery confirmed (message sent from browser appeared
in Tauri app immediately). No flicker observed in testing.

Remaining rough edge: **media download is blocked** — the webview's security policy blocks
fetch calls to the S3/MinIO origin when loading from `localhost:5173`. Needs a CSP
`connect-src` addition or an asset protocol handler for production.

### Q5 — Address book plugin

**No official Tauri plugin exists. No well-maintained community plugin found.**

A search of `github.com/tauri-apps/plugins-workspace` and the `awesome-tauri` list returns no
contacts/address book plugin as of April 2026.

Capacitor baseline: `@capacitor/contacts` (`capacitor-community/contacts`) is mature, widely
deployed, actively maintained, covers iOS and Android with a unified TypeScript API.

Effort to write a custom Tauri contacts plugin: ~100–150 lines Swift (CNContactStore),
~150–200 lines Kotlin (ContactsContract), plus Tauri plugin scaffolding. Rough estimate: 3–5
engineering days including testing on both platforms. This is custom code the project would own
and maintain indefinitely.

**Gap, not a blocker.** Capacitor's contacts plugin is standard Swift (CNContactStore) with
no novel logic — it is portable to a Tauri plugin, which also uses Swift. Estimated 3–5
days of plumbing work. The project would own and maintain it, but the effort is bounded.

### Q6 — Push notifications

`tauri-plugin-notification` (official): **local notifications only**. Remote push (APNs/FCM)
is explicitly out of scope.

Community options:

| Plugin | Stars | Last commit | Remote push |
|---|---|---|---|
| `tauri-plugin-mobile-push` | 1 | Jan 2025 | APNs + FCM |
| `tauri-plugin-notifications` (Choochmeque) | 53 | 2025 | APNs + FCM |
| `tauri-plugin-remote-push` | — | 2025 | APNs + FCM |

Server integration pattern (same across all): `registerForPushNotifications()` returns a
device token; app POSTs it to the backend; backend delivers via APNs/FCM. Token refresh events
are surfaced. This is viable but relies on community-maintained code with no official backing.

Capacitor baseline: `@capacitor/push-notifications` is an official first-party plugin, widely
deployed, Apple/Google SDK versions kept current.

**Gap, not a hard blocker** — a path exists, but it carries maintenance risk relative to
Capacitor's official plugin.

### Q7 — Build pipeline

**Web artifact** (unchanged regardless of wrapper):
```sh
cd web && npm run build:wasm   # Rust → WASM (only on crypto changes)
cd web && npm run build        # tsc + vite → web/dist/
```

**macOS** (tested, working):
```sh
cargo tauri build
# Output: src-tauri/target/release/bundle/macos/atmin.app
```

**iOS** (not run; prerequisites not installed):
```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
cargo tauri ios init       # first time: generates Xcode project
cargo tauri ios build      # or: cargo tauri ios dev  (simulator)
```
Requires: full Xcode (not CLT), Cocoapods.

**Android** (not run; prerequisites not installed):
```sh
rustup target add aarch64-linux-android armv7-linux-androideabi \
                  i686-linux-android x86_64-linux-android
cargo tauri android init   # first time: generates Android Studio project
cargo tauri android build  # or: cargo tauri android dev
```
Requires: Android Studio, NDK, `ANDROID_HOME`, `NDK_HOME`, `JAVA_HOME`.

**Rust toolchain conflict:** None. `web/crypto/` uses wasm-pack with `wasm32-unknown-unknown`
target; Tauri uses native and mobile targets. They share the same `rustup` installation and
`~/.cargo/registry` cache without conflict. Both can be invoked in the same CI pipeline.

**Known friction:**
- Media download blocked in webview — `connect-src` CSP needs explicit S3 origin.
- WASM MIME type: Vite sets `application/wasm` correctly; Tauri's asset server respects it.
  No issues observed in testing.

---

## Decision

**Tauri for desktop. Capacitor for mobile.**

### Tauri for macOS / Windows / Linux (desktop) — confirmed viable

The spike confirmed Tauri works cleanly for the desktop tray panel use case:
- No Electron (smaller binary, system webview)
- Frameless window anchored to tray icon — tested and working
- WASM, Web Crypto API, SSE — all confirmed in WKWebView on macOS
- `tauri-plugin-positioner` covers the positioning requirement
- One minor gap: media download CSP (known fix)

**Desktop: adopt Tauri.**

### Tauri for iOS / Android (mobile) — not adopted

**Mobile: adopt Capacitor.**

Desktop and web are strictly equivalent — no mobile-exclusive features exist on either.
Mobile-only features (contacts discovery, push notifications) are therefore always in
mobile-only code paths and never need to branch against a desktop equivalent.

Given that constraint, Tauri all-in for mobile was considered and ruled out. The plugin
gaps are not theoretical: contacts and push notifications are table-stakes for a messaging
app, Capacitor provides first-party plugins for both, and Tauri mobile's ecosystem does not.
Writing and owning custom native plugins would add maintenance burden with no architectural
benefit — the two frameworks serve entirely disjoint targets (tray panel vs phone app) and
never interact.

The iOS simulator work in the spike (boot confirmed, login blocked by the WKWebView POST
body localhost limitation) is a dev environment constraint, not a Tauri defect, and does
not change the decision.

---

## Blockers vs gaps

| Item | Classification | Notes |
|---|---|---|
| No contacts plugin | Gap | Capacitor's plugin is portable Swift; Tauri plugins use Swift too — it's plumbing, not novel work. Estimated 3–5 days. |
| Push notifications community-only | Gap | Viable path exists; Capacitor has official plugin |
| WKWebView drops HTTP POST bodies to localhost | Dev environment only | Affects both fetch() and XHR on iOS 18.6 and 26; HTTPS to real server is unaffected; fix: mkcert + TLS proxy or staging server |
| No physical iOS/Android device test | Open | Must test before first mobile release |
| Media download blocked in webview | Minor | CSP `connect-src` fix, 1–2 hours |
| iOS requires full Xcode | Prerequisite | Not a blocker; standard mobile dev requirement |

---

## Recommended next tasks

1. **Start Capacitor mobile** per the implementation order already in
   `docs/evolution/native-apps.md` (add Capacitor, generate iOS/Android projects,
   on-device testing, contacts plugin, push notifications).
2. **Continue Tauri desktop** — fix media download CSP, generate app icons, test on
   Windows, enumerate remaining capabilities needed (notifications on desktop, keychain
   access, file system).
3. **iOS dev environment** — before any iOS simulator testing (Tauri or Capacitor), set up
   a local HTTPS server using `mkcert` + a TLS-terminating proxy in front of the Go server,
   or point the simulator at a deployed staging URL. WKWebView silently drops HTTP POST
   bodies to `http://localhost` — this is a platform constraint affecting any WKWebView-based
   wrapper, not a framework defect.
