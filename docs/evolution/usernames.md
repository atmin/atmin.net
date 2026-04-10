# Usernames (handles → stable identifiers)

- v0.1 handles are two BIP39 words (e.g. `copper-falcon`), server-generated.
- If users could choose their handle (with uniqueness enforcement), handles become usernames.
- The resolve infrastructure (`handles/{handle}.json` → user_id) already supports this.
- A user could claim multiple handles (aliases).
- Only addition needed: a "claim handle" API with uniqueness check.
