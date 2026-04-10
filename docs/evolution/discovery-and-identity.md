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
- `discovery/phone/{hash}.json` — phone lookup (v0.2+, opt-in)
- `discovery/username/{name}.json` — username lookup (v0.2+, opt-in)
