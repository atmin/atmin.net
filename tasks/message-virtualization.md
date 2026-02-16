# Virtualize message list with @tanstack/react-virtual

## Spec
`docs/decisions/adr-0003-ui-framework.md`: use `@tanstack/react-virtual` for message list to handle 1000+ messages efficiently.

## Current
`web/src/components/ChatView.tsx` renders all messages directly in a `div` with `overflow-y-auto`. Every message is in the DOM regardless of viewport.

## Change
1. `cd web && npm install @tanstack/react-virtual`
2. In `ChatView.tsx`: replace the message list div with a virtualized list using `useVirtualizer`. Keep scroll-to-bottom behavior (auto-scroll on new messages, stick to bottom).
3. Handle variable-height rows (text messages vary in length).
4. Preserve existing styling and Storybook stories.

## Verify
- `cd web && npx tsc --noEmit` passes
- `cd web && npm test` passes
- Storybook: `WithMessages` story still renders correctly
- Manual: load a chat with 500+ messages, confirm smooth scrolling and low DOM node count
