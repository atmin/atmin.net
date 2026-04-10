# Reactive contacts across devices

v0.1 syncs contacts to S3 on every change but only restores them on session init
(new device login). This means a contact added on device A is invisible to device B
until B reloads the page (restore runs on session init).

## Cross-device push via SSE

The SSE infrastructure (ADR-0004) already delivers `new_message` events. Adding a
`contacts_updated` event makes contacts reactive:

1. Client uploads `users/{uid}/contacts.json` (existing flow).
2. Server detects the S3 write and emits `contacts_updated` to all of that user's
   connected devices (same fan-out as `new_message`).
3. Other devices receive the event, call `restoreContacts()`, and refresh the UI.

Server change: one new event type. Client change: one new SSE listener that calls
an existing function. No new storage, no new endpoints.

## User-editable contact display names

v0.1 contact names come from the peer's profile at resolve time and are not editable.
Editable names require:

1. Expand `StoredContact` with an optional `displayName` field. IndexedDB is
   schemaless for values — no migration needed.
2. Populate `display_name` in the encrypted blob (already in the ADR-0005 schema).
3. UI: inline rename on contact, writes to IndexedDB + triggers upload.
4. Display priority: user-set name > profile name > handle > userId prefix.

Pure client-side change. The encrypted blob already has a `display_name` field in its
schema (`v: 1`). The server sees no difference.

## Why this is additive

- Last-write-wins stays. S3 stays the source of truth. Client-side encryption stays.
- SSE push is a notification channel for an existing data flow — no new consistency model.
- Editable names are a client-local overlay on an existing encrypted blob field.
- No schema migration, no new server endpoints, no architectural changes.
