# Konsta migration T4b — chat screen: message timeline

> Part of the **Konsta UI migration** ([ADR-0023](../docs/decisions/adr-0023-konsta-ui.md)).
> Needs **T4a** (renders inside its shell). The message bubbles, media, and
> per-message actions.

## Goal

Rebuild the message timeline with Konsta's **`Messages`/`Message`** family
(sent/received bubbles, tails, headers/footers), preserving media rendering and
the amendment (edit/delete) affordances.

## Scope (files)

- `web/src/components/ChatMessage.tsx` → Konsta `Message` (sent/received, time
  label, edited tag, `[deleted]` placeholder). Keep the amendment rules
  (edit only text or captioned media; delete placeholder).
- `web/src/components/MediaAttachment.tsx` — keep the lazy-load + preview-first +
  status (idle/loading/ready/corrupt/unavailable) logic; reskin the chip/image/
  download presentation to sit in a Konsta `Message`.
- `web/src/components/MessageActions.tsx` → Konsta `Actions` (sheet) or `Popover`
  for the per-bubble edit/delete menu.

## Konsta components (catalog)

`Messages`, `Message` (with `type` sent/received, `text`, `image`, `header`,
`footer`, `name`), `Actions`/`ActionsGroup`/`ActionsButton` or `Popover` for the
action menu, `Dialog` for delete-confirm. Decide customization depth of
`Message` (it has slots for media/footers — likely enough without heavy override).

## Invariants to preserve (do not regress)

- Lazy-load on scroll (`IntersectionObserver`, rootMargin) + preview-first/
  full-on-tap (ADR-0022); the offline media cache.
- Amendment materialization (edit/delete), the edited-tier styling, scroll
  anchoring (`useChatScroll`) interplay.
- If `message-virtualization` later lands, the row markup must stay
  measure-friendly — keep bubbles as discrete row elements.

## Storybook

Rewrite `ChatMessage`, `MediaAttachment`, `MessageActions` stories + the
timeline-heavy `ChatView` stories (with-messages, amendments, one-editing) for
Konsta × ios/material × light/dark.

## e2e

`message-amendments.spec.ts`, `media.spec.ts` — bubble/message testids,
`media-attachment`/`media-image`/`media-chip`/`media-download`, the
edit/delete action menu, `edited-tag`, `[deleted]`. Preserve testids where cheap.

## Done when

- Timeline is Konsta `Messages`; media (lazy/preview/cache/corrupt) and
  edit/delete all work unregressed; stories updated; media + amendments e2e
  green; gates green.
