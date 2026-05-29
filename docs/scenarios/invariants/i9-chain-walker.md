# I9 — Chain walker recovers history across N rotations

> Part of the [invariants index](./README.md). Priority **P1**.
> Spec: `web/e2e/invariants/credential-rotation-continuity.spec.ts`.

**Statement.** For any sequence of credential rotations
(`kv = 1 → 2 → … → N`), a fresh device whose keys are derived at
`kv = N` recovers every message ever sent to the account by walking
`keys/{uid}/key_chain.json`. UI, Local, and Remote layers reflect the
same complete message set, in send order, with no duplicates and no
silent decryption failures.

Scenario tests cover one rotation; this invariant generalises to
`N ≥ 2`. The chain walker has to traverse strictly more than one link
or the test passes trivially.

**Fault construction.**

1. Alice registers (kv = 1) with password `pw_1`. Bob registers.
2. Bob → Alice **"era-1"** while Alice is at kv = 1.
3. Alice rotates to `pw_2` (kv = 2). Bob → Alice **"era-2"**.
4. Alice rotates to `pw_3` (kv = 3). Bob → Alice **"era-3"**.
5. A clean-IDB device signs in with `pw_3`. This is the fault
   surface: the device has no prior backup keys, so every
   pre-rotation session-key envelope (`v: 1`, `v: 2`) must be
   decrypted by walking the chain from kv = 3 back.

**Assertions.**

- `expectUI(fresh, { messageCount: 3, messageTexts: ['era-1','era-2','era-3'] })`.
- `expectLocal(fresh, convId, { uniqueMsgIdCount: 3, ordered: true })`.
- `expectRemote` — `inbox/{uid}/{live,archive}/` is non-empty; no
  duplicate keys within the live prefix. A precise per-era count is
  intentionally *not* asserted: post-compaction, all three messages
  may collapse into a single archive bundle, and the Local layer
  already proves end-to-end recoverability.
- `keys/{uid}/key_chain.json` contains exactly the links
  `[{from:1,to:2},{from:2,to:3}]`, in that order.

**Permitted divergence.** None at any layer on the fresh device. The
live/archive split on the inbox is implementation-dependent (depends
on whether compaction fired during the test) — only the total count
and the absence of duplicates are invariant.
