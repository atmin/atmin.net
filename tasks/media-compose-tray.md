# Compose tray — paste/attach, companion message, explicit send (P1d)

Phase-1 increment of [ADR-0022](../docs/decisions/adr-0022-multipart-media.md).
Today, choosing an image **sends it immediately**
([ChatView.tsx:219-228](../web/src/components/ChatView.tsx#L219-L228)) with the
filename as its only caption — there's no chance to add a message, and **no way
to paste an image at all** (the input has no `onPaste`). Replace
immediate-send-on-pick with a **compose tray**: stage one attachment (picker,
paste, or drag-drop), optionally type a message, then **Send** — one media
message whose `body` is the typed text. Purely additive on the v0.1 single
`file`; multi-select / albums stay Phase 2.

## Spec

> Attaching an image (file picker, clipboard paste, or drag-drop) **stages** it
> in a tray next to the text box rather than sending it. The user can type an
> accompanying message and remove/replace the staged item. **Send** produces a
> single media message with `body` = the typed text (falling back to the
> filename when empty). With no staged attachment, Send behaves exactly as
> today (text only).

Single attachment only — the tray holds one pending item; attaching another
replaces it. Multiple attachments per message (the "paste a bunch" flow) land
with the Phase 2 album composer (Out of scope).

The wire format is unchanged: the album schema's message-level `body` already
exists ([ADR-0022](../docs/decisions/adr-0022-multipart-media.md) §1); this task
only adds the UI to populate it. The optimize + preview generation already in
`sendMedia` (ADR-0022 §3/§4) runs on the staged file at Send, exactly as it does
today on the picked file.

## Current

- [ChatView.tsx:207-230](../web/src/components/ChatView.tsx#L207-L230) — the 📎
  control is a hidden `<input type="file">` whose `onChange` calls
  `onSendMedia(f)` **immediately**, then resets. No staging, no caption.
- [ChatView.tsx:231-244](../web/src/components/ChatView.tsx#L231-L244) — the text
  `<input>` + Send button are a **separate** path (`onSend(text)` → `sendText`).
  No `onPaste` anywhere.
- [useChatSend.sendMedia](../web/src/hooks/useChatSend.ts) — signature
  `(file) => Promise<void>`; hardcodes `body: file.name`. No caption parameter.
- [useDraft](../web/src/hooks/useDraft.ts) persists the text input per
  conversation; reused unchanged for the companion message.

## Change

### 1. `sendMedia` gains a caption

- [useChatSend.ts](../web/src/hooks/useChatSend.ts) — `sendMedia(file: File, caption?: string)`;
  set `body = caption?.trim() || file.name` (keep the filename fallback so a
  caption-less send is unchanged). Optimize, preview, and upload-then-send are
  otherwise identical.

### 2. `useComposeAttachment` hook (new) — pending-attachment lifecycle

- New `web/src/hooks/useComposeAttachment.ts`: holds the one pending
  `{ file, previewUrl }`, exposes `attach(file)` and `clear()`. Creates an object
  URL for the thumbnail and **revokes it** on replace / clear / unmount
  (object-URL lifecycle ⇒ hook, not component). Mirrors `useDraft`'s
  "called in the route, passed down as props" shape.
- Called in [chat.tsx](../web/src/routes/chat.tsx) alongside `useDraft`; pass
  `pending`, `onAttach`, `onClearAttachment` to `ChatView`.

### 3. Compose area (`ChatView`) — staging + paste + drop + send

- **Picker:** the 📎 `onChange` calls `onAttach(f)` (stage) instead of
  `onSendMedia(f)`.
- **Paste:** add `onPaste` to the text input (or the compose form) — if
  `clipboardData` carries an image item, `preventDefault` and `onAttach(file)`;
  otherwise let the text paste through untouched.
- **Drag-drop:** `onDrop` / `onDragOver` on the compose area stages a dropped
  file (cheap, same `onAttach`).
- **Tray:** when `pending`, render a small thumbnail (image → the preview object
  URL; other → a file chip with name + size) inside/above the input, with a
  remove (×) → `onClearAttachment`.
- **Send:** the submit handler branches — if `pending`,
  `onSendMedia(pending.file, inputValue)` then clear **both** the draft and the
  attachment; else `onSend(inputValue)` (today's behavior). Send is enabled when
  there is text **or** a staged attachment (a caption-less image is valid).

### 4. Architecture / layering

- The hook lives in `hooks/`, called in the route — `components/` may not import
  hook **values** (arch lint). Paste/drop are inline event handlers on elements
  (like the existing `onChange`), which is allowed in components; no `useRef`/
  `useEffect` in the component.
- `routes/` stays styling-free; the tray markup lives in `ChatView`.

## Verify

- `make lint test` + architecture lint (no hook value-imports in components;
  the preview-URL create/revoke lifecycle lives in the hook).
- Unit: `useComposeAttachment` creates a preview URL on `attach` and revokes it
  on `clear` / replace / unmount; `sendMedia` uses the caption when given and
  falls back to the filename when empty.
- Story: compose area — empty, text-only, staged-image (+ caption), staged
  non-image chip — light + dark.
- `pnpm tsc && pnpm build` (gate skips these).
- Manual: paste a screenshot → it **stages** (not sent); type a message; Send →
  recipient sees one image with the caption. Pick via 📎 → stages. Drag-drop an
  image → stages. Remove (×) clears it. Send with only text → unchanged. Send
  with only an image (no text) → caption falls back to the filename.
- e2e: a `compose` scenario + spec (`web/e2e/*.spec.ts`) — paste → stage →
  caption → send round-trips, and picker-stage-then-send.

## Out of scope

- **Multiple attachments / albums** (`attachments[]`, multi-select, per-image
  captions, grid) — Phase 2 (the clean break). This stays on the single `file`,
  one staged attachment, and the same compose tray is what Phase 2 generalizes.
- **Per-attachment captions** — Phase 2; this task carries one message-level
  `body` only.
- Reordering / editing a staged attachment beyond remove-and-replace — later.
