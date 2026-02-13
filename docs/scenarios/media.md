# Scenario: Media

Alice sends a photo to Bob. The file is encrypted client-side before upload.

**Prerequisite**: [First conversation](./first-conversation.md) completed.
Alice (session S2) and Bob (session S1) can already exchange messages.

## Cast

- **Alice** — sends a photo
- **Bob** — receives and downloads it

## 1. Alice encrypts and uploads the file

Alice selects `photo.jpg` (48KB). Her client:

1. Generates a random AES-256-GCM key and 12-byte IV.
2. Encrypts the file: `encrypted_blob = AES-256-GCM(key, iv, photo.jpg)`.
3. Computes `sha256` of the **plaintext** file (for integrity check after decryption).
4. Requests a presigned PUT URL:

```
POST /v1/store/presign
{ "key": "media/alice01/<sha256>/photo.jpg", "bytes": 48080 }
→ { "presigned_url": "..." }
```

5. Uploads the encrypted blob:

```
PUT <presigned_url>
← <encrypted_blob bytes>
```

S3 writes:
- `media/alice01/<sha256>/photo.jpg` — encrypted file (opaque to server)

The per-file key never leaves Alice's device unencrypted — it travels
inside the Megolm-encrypted message payload.

## 2. Alice sends the message

Alice sends the file reference inside her Megolm session S2.
The file key, IV, URL, and hash are all inside the encrypted payload.

```
POST /v1/send
{
  "envelopes": [
    {
      "v": 1,
      "to_user": "bob01",
      "from_user": "alice01", "from_device": "adev01",
      "msg_id": "msg008",
      "sent_at": "...",
      "content_type": "megolm.message",
      "payload": {
        "session_id": "S2",
        "ciphertext": "<base64 Megolm(S2, inner_plaintext)>"
      }
    },
    {
      "v": 1,
      "to_user": "alice01",
      "from_user": "alice01", "from_device": "adev01",
      "msg_id": "msg008",
      "sent_at": "...",
      "content_type": "megolm.message",
      "payload": {
        "session_id": "S2",
        "ciphertext": "<base64 Megolm(S2, inner_plaintext)>"
      }
    }
  ]
}
```

Where `inner_plaintext` (what Megolm encrypts) is:

```json
{
  "type": "media",
  "body": "photo.jpg",
  "file": {
    "url": "media/alice01/<sha256>/photo.jpg",
    "key": "<base64 AES-256-GCM key>",
    "iv": "<base64 12-byte IV>",
    "sha256": "<hex>"
  }
}
```

S3 writes:
- `inbox/bob01/live/msg008` — message
- `inbox/alice01/live/msg008` — self-copy

No new key share — Bob already has S2 from the first conversation.

## 3. Bob syncs and downloads

```
GET /v1/store/list?prefix=inbox/bob01/live/&cursor=msg004
→ ["inbox/bob01/live/msg008"]

GET /v1/store/object?key=inbox/bob01/live/msg008
```

Bob decrypts with Megolm session S2 → gets the inner plaintext with file reference.

Bob's client downloads and decrypts the file:

```
GET /v1/store/object?key=media/alice01/<sha256>/photo.jpg
```

1. Decrypts with the AES-256-GCM key and IV from the message payload.
2. Computes SHA-256 of the decrypted file, verifies it matches the hash.
3. Renders the photo.

## S3 state (new objects only)

```
media/alice01/<sha256>/photo.jpg    ← encrypted file

inbox/bob01/live/msg008             ← message with file reference
inbox/alice01/live/msg008           ← self-copy
```

## Security properties

- **Server sees**: an opaque encrypted blob at a content-addressed path and an opaque envelope. It cannot associate the blob with the message (the URL is inside the Megolm ciphertext).
- **Per-file key**: each file gets its own random AES-256-GCM key. Compromising one file key does not affect others.
- **Integrity**: SHA-256 hash inside the encrypted payload lets the recipient verify the file was not tampered with at rest.
- **Content-addressed path**: `media/{user_id}/{sha256}/{filename}` — uploading the same file twice is idempotent (same key, same path, same ciphertext).

## What to test

- Encrypted upload via presigned URL succeeds.
- Bob decrypts the file using key/IV from the message payload.
- SHA-256 integrity check passes.
- Wrong file key fails decryption.
- Server cannot correlate blob path with envelope (URL only visible inside Megolm ciphertext).
