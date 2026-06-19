# Konsta UI adoption spike (v0.2 client UX)

> **Status: spike — throwaway prototype on a branch, NOT merged.** It produces a
> **go/no-go + findings**, after which this task is deleted and (if go) replaced
> by an ADR amending [ADR-0003](../docs/decisions/adr-0003-ui-component-framework.md)
> plus a real, incremental migration task. Time-box ≈1–2 days. Spike code is
> disposable — it need not satisfy the arch-lint or full gates (it won't merge),
> but it **must build** (`pnpm build`) so the bundle delta is real.

## Why a spike (not a task)

This is **Option A** of the v0.2 client-UX direction: Konsta UI (Tailwind-based
iOS/Material components) standalone, with motion layered on top via the **View
Transitions API** — chosen over Framework7 and Ionic because it keeps our router,
our Tailwind, and the layered arch (they own the router + bring non-Tailwind
styling). Adopting a UI component layer is an ADR-0003-level decision; prototype
the cheapest risks first so the ADR is written from evidence, not hope.

## Questions to answer (cheapest-killing-risk first)

1. **(Kill risk) Does Konsta render under our Tailwind v4 setup at all?** We are
   CSS-first v4 (no `tailwind.config.js`); Konsta historically ships a v3-style
   Tailwind **preset**. The likely bridge is v4's `@config` directive loading a
   small JS config that pulls Konsta's preset — *verify Konsta actually supports
   v4 first.* If this can't be made clean, the decision becomes "downgrade
   Tailwind?" (a real migration) or "no-go."
2. **One real screen, both themes:** does the conversation list look right in
   `ios` **and** `material`, in **light and dark**?
3. **Three shells:** does it hold in web (Vite), Capacitor (iOS/Android sim), and
   the Tauri tall-rectangle desktop window — including **mouse**-driving any
   swipe affordance, not just touch?
4. **Motion:** does one navigation (list → chat) with a View Transition feel
   native? React Router v7 has built-in support (`viewTransition` on `<Link>` /
   `navigate(..., { viewTransition: true })`) — no extra lib needed for the trial.
5. **Bundle delta** vs current, gzipped (ADR-0003's lightweight-bundle stance is
   the bar).
6. **Coherence/migration:** Konsta + Tailwind + shadcn + the layered arch — do we
   **replace the chrome** (nav/list/sheets/inputs on Konsta) or **mix**? Sketch
   the migration shape.

## Current state (what the spike builds against)

- **Tailwind v4, CSS-first** — [vite.config.ts](../web/src/../vite.config.ts)
  uses `@tailwindcss/vite`; [src/index.css](../web/src/index.css) is
  `@import "tailwindcss"` + `@theme inline` + `@import "shadcn/tailwind.css"`,
  **no `tailwind.config.js`**. This is exactly the setup Q1 is about.
- **Router: React Router v7** — [routes/app.tsx](../web/src/routes/app.tsx)
  (`<Routes>/<Route>`), `useNavigate`. RR7's built-in View Transitions cover Q4.
- **Candidate screen: the conversation list** —
  [routes/chats.tsx](../web/src/routes/chats.tsx) →
  [ChatsView](../web/src/components/ChatsView.tsx). Cheapest first screen
  (navbar + list rows + theming, no compose/media complexity). The chat view
  ([ChatView](../web/src/components/ChatView.tsx), with the compose tray + media)
  is a **stretch** screen only if time remains — it exercises far more.
- **shadcn is the incumbent** (index.css imports `shadcn/tailwind.css`); Konsta is
  being evaluated as the replacement for the mobile chrome, not an addition.
- **Desktop PoC lives on the Tauri branch** — branch the spike so the tall-rect
  window is available for Q3; coordinate the base.

## Plan (time-boxed, on a disposable branch)

0. Branch `konsta-spike`. Throwaway — do not target master.
1. **Q1 first, alone.** Install `konsta`, wire its preset under Tailwind v4 (the
   `@config` bridge, or Konsta's current v4 guidance), get **one** `<Button>`
   rendering correctly in both `ios` and `material`. If this isn't clean within
   ~half a day, **stop and write findings** — Q1 is the decision.
2. **Q2.** Rebuild the conversation list with Konsta (`App`/`Page`/`Navbar`/
   `List`/`ListItem`), wire the `theme` prop, verify `ios`+`material` × light+dark.
3. **Q4.** Wrap the list→chat navigation with RR7 `viewTransition` + a CSS
   `::view-transition` rule; feel the motion. Try a swipe-back gesture only if
   cheap.
4. **Q3.** Run the spike screen in all three shells; in the Tauri window confirm
   any swipe affordance is also mouse-drivable (and add a click target where it
   isn't — per the desktop constraint).
5. **Q5.** `pnpm build`; record the gzipped delta vs a baseline build.
6. **Q6.** Write up coexistence (replace-chrome vs mix) + a migration sketch.

## Decision / kill criteria

- **No-go (or "downgrade Tailwind" decision)** if Q1 can't be solved cleanly
  under v4.
- **Go** if Q1–Q4 hold and Q5's delta is acceptable per ADR-0003.
- If the **navigation feel** is the gap (Q4 unsatisfying even with RR7 View
  Transitions), record **Option B** as the fallback — Ionic's shell + Konsta
  components (`theme="parent"`). Note the friction: Ionic React is React-Router
  coupled and historically pins older RR, vs our RR7.

## Deliverable

- A short **findings note** (screenshots: 2 themes × light/dark, 3 shells; bundle
  numbers; the Q1 mechanism that worked) — drop-in material for the ADR.
- **If go:** a new ADR superseding/amending ADR-0003, plus an **incremental**
  migration task (chrome first, screen by screen). Delete this task + the branch.
- **If no-go:** a brief ADR/note recording why; delete the branch.

## Out of scope

- Migrating all screens — this is **one** screen (plus an optional stretch).
- Production polish, a11y pass, removing shadcn — that's the migration, not the spike.
- Native push/contacts — native track, deferred.
- A gesture library beyond a single swipe-back trial.
- The real implementation's arch compliance (theme detection + any lifecycle must
  live in a **hook**, mirroring `useDraft`/`useComposeAttachment`) — note it for
  the migration; don't gate the throwaway spike on it.

## Verify (done-when)

- Q1–Q5 answered with concrete evidence (the build number and the screenshot
  matrix), Q6 sketched.
- A written **go/no-go recommendation** exists.
- The spike branch is **not merged** to master; all conclusions are captured in
  the findings note / ADR so the branch can be deleted without loss.
