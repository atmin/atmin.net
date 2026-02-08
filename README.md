# atmin.net

A sync-first, end-to-end encrypted messenger with a stateless Go backend and client-owned data.

## What it is

atmin.net is an experimental messaging system built around a simple idea:  
the server is a dumb relay and mailbox, while clients own their keys, history, and trust.

There is no central database, no plaintext on the server, and no required phone numbers or email addresses.

This project treats documentation as the primary interface — for humans and machines alike.

## Architecture (high level)

- End-to-end encryption on the client (browser-first)
- Cryptography based on the Matrix E2EE stack (Olm/Megolm via WASM)
- Stateless Go server
- S3-compatible storage for messages and media
- Sync-first delivery model (offline-friendly by design)
- Invite-based identity discovery

## Status

Early development.  
Expect breaking changes.

## License

Apache License 2.0.  
See [LICENSE](LICENSE) for details.
