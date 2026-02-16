# Add profile management UI (display name, avatar)

## Spec
`docs/decisions/adr-0005-profiles-contacts.md`: `PUT /v1/profile` accepts `{display_name, avatar_url}`. Server does read-merge-write on `users/{uid}/profile.json` and projects to `invites/{handle}.json`. Server endpoint is already implemented.

## Current
No client UI for setting display name or avatar. The server handler exists and is tested (`server/handlers.go` `handleProfile`), but the client never calls it.

## Change
1. Add a profile/settings component in `web/src/components/` with display name input and avatar upload.
2. Add a `useProfile` hook or extend `useSession` to call `PUT /v1/profile`.
3. For avatar: encrypt and upload to `media/{userId}/...` via presigned URL, then set `avatar_url` in profile. (Depends on media-upload task — can ship display name first, avatar later.)
4. Add a route or modal to access settings from the chats view.

## Verify
- `cd web && npx tsc --noEmit` passes
- `cd web && npm test` passes
- Manual: set display name, resolve from another user — display name shows
