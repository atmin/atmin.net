# Threads / topics (client-side conversations)

- v0.1 has no server-side concept of "conversations."
  Clients materialize chats by grouping messages by `from_user`.
- Multiple conversations between the same pair of users (e.g. per topic)
  can be supported by adding a `thread_id` inside the encrypted payload.
- Client groups by `(from_user, thread_id)` instead of just `from_user`.
- Zero server changes — pure client-side concept.
- Fits the "client-side intelligence over server-side state" principle.
