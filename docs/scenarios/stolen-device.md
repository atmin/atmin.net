# Scenario: Stolen device

Alice's phone is stolen. She revokes it from her laptop,
and the thief's access is terminated.

**Prerequisite**: [Multi-device](./multi-device.md) completed.
Alice has a laptop (`adev01`) and phone (`adev02`). Bob has `bdev01`.

## Cast

- **Alice** — revokes her stolen phone
- **Eve** — has Alice's phone (unlocked, default PIN)
- **Bob** — continues conversation with Alice

## Starting S3 state

Same as multi-device end state. Relevant subset:

```
users/alice01/profile.json
users/alice01/devices/adev01.json
users/alice01/devices/adev02.json
users/bob01/profile.json
users/bob01/devices/bdev01.json

inbox/alice01/live/msg001..msg007
inbox/bob01/live/msg002..msg007

keys/alice01/live/S1
keys/alice01/live/S2
keys/alice01/live/S3
```

## 1. Eve reads what's already on the phone

Eve has physical access to Alice's unlocked phone. IndexedDB contains:

- Sharing private key
- Backup encryption key
- Device token (`tok_a2`)
- Megolm session keys (S1, S2, S3)
- Full chat history (plaintext after decryption)

Eve reads all existing messages. **This damage is immediate and irreversible** —
the messages were already decrypted and stored locally.

## 2. Eve syncs new messages

Before Alice notices the theft, Bob sends a message:

```
POST /v1/send
{
  "envelopes": [
    {
      "to_user": "alice01", ...,
      "content_type": "megolm.message",
      "msg_id": "msg008",
      "payload": { "session_id": "S1", "ciphertext": "<Megolm(S1, 'Are you free tonight?')>" }
    },
    { "to_user": "bob01", ..., "msg_id": "msg008", ... }
  ]
}
```

Eve's phone syncs (using `tok_a2`):

```
GET /v1/store/list?prefix=inbox/alice01/live/&cursor=msg007
→ ["inbox/alice01/live/msg008"]

GET /v1/store/object?key=inbox/alice01/live/msg008
```

Eve has S1 → decrypts "Are you free tonight?". **She is reading in real time.**

## 3. Alice revokes the phone

Alice notices the theft and opens her laptop. She lists her devices:

```
GET /v1/store/list?prefix=users/alice01/devices/
→ ["users/alice01/devices/adev01.json", "users/alice01/devices/adev02.json"]
```

Alice revokes the phone. She enters her 12-word mnemonic to derive the auth key
and sign the revocation proof:

```
POST /v1/devices/revoke
{
  "device_id": "adev02",
  "auth_proof": {
    "payload": { "user_id": "alice01", "device_id": "adev02", "timestamp": "2025-01-16T14:00:00Z" },
    "signature": "<Ed25519 signature>"
  }
}
```

Server deletes `users/alice01/devices/adev02.json`.

S3 state change:
- `users/alice01/devices/adev02.json` — **deleted**

## 4. Eve's phone self-wipes

Eve's phone makes its next API call (sync, send, anything):

```
GET /v1/store/list?prefix=inbox/alice01/live/&cursor=msg008
→ 403 device_revoked
```

The client receives `403 device_revoked` and executes self-wipe:

1. Deletes all IndexedDB data (sharing key, backup key, session keys, chat history).
2. Clears device token.
3. Returns to welcome screen.

Eve now sees a blank app. She cannot sync, send, or read cached messages.

**Caveat**: self-wipe is best-effort. If Eve puts the phone in airplane mode
before it contacts the server, the wipe never triggers. But without API access,
Eve's cryptographic keys are useless — she cannot obtain new ciphertexts.
Damage is limited to what was already downloaded (steps 1–2).

## 5. Eve's keys are now useless

Even though Eve still has (in theory, pre-wipe):

- **Sharing private key** — can decrypt key shares, but cannot fetch new ones (no API access).
- **Backup encryption key** — can decrypt key backups, but cannot list or download them.
- **Session keys S1, S2, S3** — can decrypt messages encrypted with these sessions,
  but cannot download new inbox objects.
- **Device token `tok_a2`** — rejected by server (`adev02.json` is gone).

Without API access, every key is a key to a door Eve can't reach.

## 6. Alice continues chatting (post-revocation)

Alice sends from her laptop, still using session S2:

```
POST /v1/send
{
  "envelopes": [
    {
      "to_user": "bob01", ...,
      "from_device": "adev01",
      "content_type": "megolm.message",
      "msg_id": "msg009",
      "payload": { "session_id": "S2", "ciphertext": "<Megolm(S2, 'New phone, who dis')>" }
    },
    { "to_user": "alice01", ..., "msg_id": "msg009", ... }
  ]
}
```

Bob syncs and decrypts normally. Eve cannot fetch `msg009` — request is rejected.

**Note**: Alice's existing session keys (S2) remain valid for Megolm encryption.
Eve has S2 but cannot download the ciphertexts. If Alice wants defense-in-depth
against compound threats (e.g. a future server compromise), she can rotate her
backup secret — see [evolution notes](../evolution/device-revocation.md).

## S3 state after scenario

```
users/alice01/profile.json
users/alice01/devices/adev01.json
                                         ← adev02.json deleted
users/bob01/profile.json
users/bob01/devices/bdev01.json

inbox/alice01/live/msg001..msg008
inbox/alice01/live/msg009               ← new (post-revocation)

inbox/bob01/live/msg002..msg008
inbox/bob01/live/msg009                 ← new

keys/alice01/live/S1
keys/alice01/live/S2
keys/alice01/live/S3
```

## Security properties

- **Pre-revocation damage is bounded**: Eve reads only what was already on-device plus messages synced before revocation.
- **Post-revocation access is zero**: no API call succeeds without a valid device file.
- **Self-wipe is defense-in-depth**: clears local data on next network contact. Not a guarantee (airplane mode), but a useful mitigation.
- **No impersonation**: Eve cannot send messages as Alice — `POST /v1/send` requires a valid token.
- **No new devices**: adding a device requires the backup secret (12-word mnemonic), which is not stored on-device.
- **Existing session keys are safe to reuse**: Eve has S2 but cannot obtain ciphertexts encrypted with it. Alice does not need to rotate sessions (but may choose to for defense-in-depth).

## What to test

- Revocation deletes device file; subsequent API calls return `403 device_revoked`.
- Client self-wipes on receiving `403 device_revoked` (IndexedDB cleared, returns to welcome screen).
- Revoked device cannot sync inbox, fetch key backups, or send messages.
- Non-revoked device (laptop) continues operating normally.
- Revocation requires valid `auth_proof` (cannot revoke without backup secret).
- Device list no longer includes revoked device.
