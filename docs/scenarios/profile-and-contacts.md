# Scenario: Profile and contacts

Alice sets up her profile, Bob resolves her handle and sees her display name,
then both add each other as contacts and sync across devices.

**Prerequisite**: [First conversation](./first-conversation.md) completed.
Alice (`alice01`, device `adev01`) and Bob (`bob01`, device `bdev01`) have
exchanged messages. Alice also has a second device (`adev02`) from
[Multi-device](./multi-device.md).

## Cast

- **Alice** — sets display name and avatar, manages contacts
- **Bob** — resolves Alice's enriched profile, adds her as a contact

## Starting S3 state

Relevant subset:

```
users/alice01/profile.json        ← { user_id, invite_handle, auth_public_key, sharing_public_key }
users/alice01/devices/adev01.json
users/alice01/devices/adev02.json
users/bob01/profile.json
users/bob01/devices/bdev01.json

handles/alice-xyz.json            ← { user_id, sharing_public_key }
handles/bob-abc.json
```

## 1. Alice sets her display name and avatar

Alice uploads an avatar via presigned PUT:

```
POST /v1/store/presign
{ "key": "media/alice01/avatar/abc123.jpg", "bytes": 34000 }
→ { "presigned_url": "..." }

PUT <presigned_url>
← <encrypted image bytes>
```

Alice updates her profile:

```
PUT /v1/profile
{
  "display_name": "Alice Wonderland",
  "avatar_url": "media/alice01/avatar/abc123.jpg"
}
→ 200
```

Server performs read-merge-write:
1. Reads `users/alice01/profile.json`, merges `display_name` and `avatar_url`.
2. Writes updated `users/alice01/profile.json`.
3. Projects public fields to `handles/alice-xyz.json`.

S3 state change:
- `users/alice01/profile.json` — now includes `display_name`, `avatar_url`
- `handles/alice-xyz.json` — now includes `display_name`, `avatar_url`, `sharing_public_key`
- `media/alice01/avatar/abc123.jpg` — avatar blob

## 2. Bob resolves Alice's enriched profile

```
GET /v1/resolve/alice-xyz
→ {
    "user_id": "alice01",
    "sharing_public_key": "<alice_sharing_pub>",
    "display_name": "Alice Wonderland",
    "avatar_url": "media/alice01/avatar/abc123.jpg"
  }
```

Server reads only `handles/alice-xyz.json` — no second S3 read needed.

Bob's client displays "Alice Wonderland" with her avatar.

## 3. Alice updates only her display name

```
PUT /v1/profile
{ "display_name": "Alice W." }
→ 200
```

Server merges: `display_name` changes, `avatar_url` is preserved (not in request).

Both `profile.json` and `handles/alice-xyz.json` now show `"Alice W."` with
the same `avatar_url`.

## 4. Bob adds Alice as a contact

Bob's client builds a contact list and encrypts it with his backup key
(AES-256-GCM):

```json
{
  "v": 1,
  "contacts": [
    {
      "user_id": "alice01",
      "handle": "alice-xyz",
      "display_name": "Alice W.",
      "sharing_public_key": "<alice_sharing_pub>",
      "added_at": "2026-02-15T12:00:00Z"
    }
  ]
}
```

Upload via presigned PUT:

```
POST /v1/store/presign
{ "key": "users/bob01/contacts.json", "bytes": 512 }
→ { "presigned_url": "..." }

PUT <presigned_url>
← { "iv": "<base64>", "ciphertext": "<base64 AES-256-GCM encrypted contacts>" }
```

S3 state change:
- `users/bob01/contacts.json` — encrypted contacts blob

Note: `authorizeKeyWrite` allows this because the key starts with `users/bob01/`.
An attempt to write `users/alice01/contacts.json` would return 403.

## 5. Alice adds Bob as a contact

Same flow. Alice encrypts and uploads to `users/alice01/contacts.json`.

## 6. Alice syncs contacts on her second device

Alice's second device (`adev02`) downloads the contacts:

```
GET /v1/store/object?key=users/alice01/contacts.json
→ { "iv": "...", "ciphertext": "..." }
```

The device decrypts with Alice's backup key (derived from her 12-word mnemonic)
and displays Bob in the contact list.

Last-write-wins: if both devices edit contacts simultaneously, the last upload
wins. This is acceptable — contact edits are infrequent and user-initiated.

## S3 state after scenario

```
users/alice01/profile.json        ← now has display_name, avatar_url
users/alice01/contacts.json       ← encrypted
users/alice01/devices/adev01.json
users/alice01/devices/adev02.json

users/bob01/profile.json
users/bob01/contacts.json         ← encrypted
users/bob01/devices/bdev01.json

handles/alice-xyz.json            ← now has display_name, avatar_url
handles/bob-abc.json

media/alice01/avatar/abc123.jpg   ← avatar blob
```

## What to test

- `PUT /v1/profile` with both fields updates profile and invite file.
- Partial update (one field) preserves the other.
- `GET /v1/resolve` returns display_name and avatar_url from enriched invite.
- Presigned write to own `users/{uid}/` succeeds; to another user's returns 403.
- Contacts encrypt/upload/download round-trips correctly.
- Second device can decrypt contacts with the same backup key.
