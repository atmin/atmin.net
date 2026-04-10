# Email gateway

If handles are stable identifiers, `{handle}@atmin.net` becomes a valid email address.
The gateway is just another writer using the public API.

**Plaintext email** (standard SMTP):

1. Receive email at `{handle}@atmin.net`.
2. Resolve handle → user_id + sharing_public_key.
3. Gateway encrypts the email body with the recipient's sharing key.
4. Deliver via `POST /v1/send` with `content_type: gateway.email`.

Gateway sees plaintext — inherent to email, not a new compromise.

**PGP-encrypted email** (true E2E):

The sharing key is Curve25519, which PGP supports. It can be published as a PGP
public key via WKD (Web Key Directory) at `atmin.net`.

1. External sender encrypts email with Alice's PGP key (= sharing public key).
2. Gateway receives PGP ciphertext — **cannot read it**.
3. Gateway wraps the opaque ciphertext in an envelope with `content_type: gateway.pgp_email`.
4. Delivers to inbox as-is. No Megolm needed — PGP already provides E2E.
5. Alice's client decrypts with her sharing private key.

The sharing key does double duty: Megolm key shares from atmin.net users,
and PGP encryption from external senders. Same key, two protocols.
