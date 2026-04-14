# Spike: Tauri as unified native wrapper (mobile + desktop)

## Context

`docs/evolution/native-apps.md` specifies Capacitor for mobile (iOS/Android). Desktop native is
not yet planned. A candidate architecture would use Tauri v2 for everything: iOS, Android, macOS,
Windows — one native bridge, one plugin API, one build tool, no Electron.

The spike answers whether that is viable before any native work begins.

**App:** React 19 + Vite SPA (`web/`). Build: `cd web && npm run build` (`tsc && vite build`).
Output goes to `web/dist/` — this is what any native wrapper serves from a webview.

**Crypto layer — two components:**

1. *Web Crypto API* (`web/src/lib/crypto.ts`) — browser-native, no WASM. HKDF, Ed25519, ECDH,
   AES-GCM. Works in any modern webview without special configuration.

2. *Rust WASM module* (`web/crypto/`) — compiled with `wasm-pack` to
   `web/crypto/pkg/atmin_crypto.js`. Provides `MegolmOutbound` / `MegolmInbound` (Megolm group
   encryption). Loaded at runtime via dynamic import in `web/src/lib/wasm.ts`: the browser path
   calls `mod.default()` to fetch and initialize the `.wasm` binary. Build command:
   `cd web && npm run build:wasm`. The `.wasm` binary is bundled into `web/dist/` by Vite.
   This module does not use `SharedArrayBuffer` or worker threads, so COOP/COEP headers are
   not required — but the webview must support WASM execution at all.

**Native capabilities needed:** push notifications, address book access, camera (future), device
attestation (future, mobile-only — see `docs/evolution/native-apps.md` for attestation design).

**Prior decision baseline:** `docs/evolution/native-apps.md` evaluated React Native, Tauri Mobile,
raw Swift/Kotlin wrappers, and PWA-only before selecting Capacitor. The "Tauri Mobile immature"
note predates v2 (released Oct 2024). This spike re-evaluates that assumption and also adds
desktop, which the prior doc does not address.

## Questions to answer

### 1. Does the app run on a physical iOS device via Tauri?

Boot the existing web app inside a Tauri iOS shell. Confirm: pages load, routing works, no console
errors. Record the iOS and WKWebView version.

**Output:** Yes / No. If no, what breaks.

### 2. Does the app run on a physical Android device via Tauri?

Same as above on Android. Record Android version and system WebView version.

**Output:** Yes / No. If no, what breaks.

### 3. Does WASM run in the system webview on both platforms?

`web/src/lib/wasm.ts` dynamically imports `web/crypto/pkg/atmin_crypto.js` and calls
`mod.default()` to fetch and initialize the `.wasm` binary. This must work in WKWebView (iOS)
and Android System WebView. Load the app, register a test account, send a message — if
encryption succeeds, WASM works. The module does not use SharedArrayBuffer so COOP/COEP are
not the expected failure mode; the risk is older WebView versions lacking WASM support entirely.

**Output:** Yes / No per platform. If no: what is the minimum WebView version that works, and
what percentage of target devices would be excluded?

### 4. Does the desktop tray panel work on macOS?

Using `tauri-plugin-tray` and `tauri-plugin-positioner`: configure a frameless window (~390×780),
show/hide it on tray icon click, position it anchored to the tray icon.

**Output:** Yes / No. Screenshot of the panel open. Note any rough edges (flicker, positioning
offset, focus behavior).

### 5. What is the address book story?

Check for an official or well-maintained community Tauri plugin for contacts access on iOS and
Android.

**Output:** Plugin name + last commit date + iOS/Android coverage, OR "no plugin exists." If no
plugin: estimate the effort to write one (lines of Swift + Kotlin, rough days), referencing
Capacitor's `@capacitor/contacts` as a baseline.

### 6. What is the push notification story?

`tauri-plugin-notification` covers local notifications. Determine whether it supports remote push
(APNs on iOS, FCM on Android) — specifically: does it handle the device token registration and
delegate it to the app server, or is remote push out of scope?

**Output:** Local only / Remote supported. If remote: what does the server integration look like?
If local only: is there a path (community plugin, manual native code) to remote push?

### 7. Build pipeline integration

The web artifact is produced by:
```
cd web && npm run build:wasm   # Rust → WASM (only needed when crypto changes)
cd web && npm run build        # tsc + vite → web/dist/
```

Document what wraps this to produce a runnable Tauri app on each platform. Note any friction
with the current Vite + wasm-pack setup (e.g. asset path handling, Content-Security-Policy in
the webview, wasm MIME type).

**Output:** Step-by-step command sequence for each target (iOS, Android, macOS). Flag any
non-obvious requirements (Rust toolchain version, Xcode version, NDK version, etc.). Note:
Tauri itself requires Rust — confirm this does not conflict with the existing `web/crypto/`
Rust/wasm-pack toolchain.

## Out of scope

- Device attestation — confirmed custom native work regardless of wrapper; evaluate separately
- Windows and Linux desktop — validate macOS first
- Any UI changes
- Store submission
- Any feature work

## Decision output

After completing the above, write a one-page recommendation at `docs/decisions/adr-XXXX-native-wrapper.md` covering:

- **Tauri all-in (mobile + desktop)** — viable or not, and why
- **Fallback: Tauri desktop + Capacitor mobile** — if Tauri mobile has a hard blocker (e.g. no
  contacts plugin, WASM failure), Capacitor handles iOS/Android (mature plugin ecosystem
  including `@capacitor/contacts`, `@capacitor/push-notifications`) while Tauri handles macOS/
  Windows/Linux (tray panel, system webview, no Electron). This means two native bridges and two
  plugin APIs to maintain, but the same web build serves both. The prior evaluation in
  `docs/evolution/native-apps.md` already validated Capacitor's mobile story.
- Blockers (hard no) vs gaps (custom plugin work, known effort)
- Recommended next task if a strategy is approved
