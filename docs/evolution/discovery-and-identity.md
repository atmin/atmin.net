# Discovery and identity (deferred)

- v0.1 uses invite-based discovery only.
- No phone numbers, email addresses, or address book access are required.
- Handles are resolved via S3 lookup objects (`handles/{handle}.json`).

Future directions (opt-in, undecided):
- Public identifier discovery (e.g. verified phone numbers).
- Privacy-preserving contact matching.
- Additional identity claims layered on top of the existing model.

When discovery needs grow beyond S3 GET lookups, a cache layer (e.g. Redis) can be
introduced. S3 remains the source of truth; the cache is reconstructable by scanning
S3 prefixes (`handles/`, `users/`, `discovery/`). Cache loss causes discovery downtime,
not data loss. Index objects follow a convention:

- `handles/{handle}.json` — handle lookup (v0.1)
- `discovery/phone/{oprf}.json` — phone lookup (opt-in, native-apps track)
- `discovery/username/{name}.json` — username lookup (opt-in)

## Privacy model (must hold before any phone discovery ships)

A plain `H(phone)` index is **not** private: the phone-number space is small
(~10^10), so anyone holding the index — including the server — can enumerate every
hash offline and recover every number. The index key must instead be an **OPRF**
output (the server applies a secret key to *blinded* client inputs, so it never sees
a plaintext number and the index can't be brute-forced offline) or a full **PSI**
protocol (à la Signal: OPRF + secure enclave). This implies shared server state — a
key plus a rate-limited match endpoint, possibly an enclave — a deliberate step
beyond today's stateless S3, consistent with the "incremental complexity" principle.

Two guarantees, not equally airtight — state them precisely:

- **The server never reads your address book.** Raw contacts stay on-device; only
  blinded values ever leave. This is the clean, load-bearing promise.
- **The server never learns your phone number** holds fully for anyone who does not
  opt in (they publish nothing). For an opt-in-discoverable user, a server holding
  the OPRF key can still brute-force the small number space to recover the published
  mapping — so airtight opt-in *number* privacy needs enclave-grade protection. Lead
  with the address-book guarantee, not a blanket number guarantee.
