# Evolution notes

This directory captures likely future evolution paths of the system.
It is **not a roadmap or a commitment**.

The purpose is to preserve context, design intent, and known trade-offs,
so future changes do not require rediscovering the same discussions.

## Index

- [Real-time delivery](./realtime-delivery.md)
- [Discovery and identity](./discovery-and-identity.md)
- [Reactive contacts across devices](./reactive-contacts.md)
- [Usernames](./usernames.md)
- [Email gateway](./email-gateway.md)
- [Threads / topics](./threads.md)
- [Device revocation and key rotation](./device-revocation.md)
- [Large media](./large-media.md)
- [Native apps (Capacitor)](./native-apps.md)
- [Rich text / markdown editing](./rich-text.md)
- [Service telemetry and privacy-preserving analytics](./telemetry-and-analytics.md)

## Guiding principle

Evolution should favor:
- additive changes over breaking rewrites,
- client-side intelligence over server-side state,
- simple failure modes over complex coordination.

If a change requires centralized state, it must be clearly justified
and documented via an ADR.
