# Storage-used indicator in settings

## Motivation

v0.1 ships without media GC. Orphan blobs and legitimate attachments both
count against the 1 GiB quota until account deletion. Without a visible
"storage used" figure, users have no way to notice pressure or act on it.

A minimal indicator gets ~80% of the value of shipping GC for a fraction of
the effort, and the same endpoint is reusable for GC's future UX
("X MB reclaimable").

## Current state

- `MediaQuotaStore` ([media_quota.go:21-27](../server/media_quota.go)) has
  only `ReserveUpload`. No read path.
- `s3UsageProbe(ctx, store, uid)` ([media_quota.go:48-58](../server/media_quota.go))
  already returns `(totalBytes int64, count int, err error)` via
  `ListObjectSizes` — usable directly.
- Cache TTL = `QUOTA_CACHE_TTL = 10 * time.Minute`; cache is keyed by uid
  and shared by all callers of the same `*inProcessMediaQuota`.
- Constants: `USER_MEDIA_QUOTA_BYTES = 1 << 30` (1 GiB),
  `USER_MEDIA_BLOB_CAP = 1000`.
- Existing storage routes use `/v1/store/*` prefix
  ([routes.go:27-30](../server/routes.go)).
- [routes.go:29](../server/routes.go) constructs `NewMediaQuota(store)`
  inline — needs extraction to share the instance.
- [routes/settings.tsx](../web/src/routes/settings.tsx) renders
  `<ProfileSettings><DeviceSettings/></ProfileSettings>` via the `children`
  slot ([ProfileSettings.tsx:109](../web/src/components/ProfileSettings.tsx)).
- Existing hook+component split precedent: `useDevices` + `DeviceSettings`
  ([useDevices.ts](../web/src/hooks/useDevices.ts)).

## Architecture constraints

[lint-architecture.sh](../web/scripts/lint-architecture.sh):
- `components/` may not use `useEffect` or value-import from `@/hooks/`.
- `hooks/` files must be `.ts`.

Therefore: a `useStorageUsage` hook owns the fetch state; `StorageIndicator`
is pure presentational; the route calls the hook and passes data down. Same
shape as `useDevices` + `DeviceSettings`.

## Change

### 1. `docs/specs/mvp-v0.1.md` — document the new endpoint

Add a section under "Storage API" alongside list/object/presign/compact:

> #### Usage
>
> `GET /v1/store/usage`
>
> Output:
> ```json
> {
>   "used_bytes": 357564416,
>   "quota_bytes": 1073741824,
>   "blob_count": 12,
>   "quota_blob_cap": 1000
> }
> ```
>
> Returns the caller's media usage from the server's quota cache (TTL 10
> min); on miss, the server probes S3 via `ListObjectSizes` under
> `media/{uid}/`. No prefix authorization needed — the endpoint is implicitly
> scoped to the authenticated user.

### 2. `server/media_quota.go` — extend the interface

```go
type MediaQuotaStore interface {
    ReserveUpload(ctx context.Context, userID string, bytes int64) (ok bool, reason string, err error)
    GetUsage(ctx context.Context, userID string) (usedBytes int64, blobCount int, err error)
}
```

Implement on `inProcessMediaQuota`:

```go
func (q *inProcessMediaQuota) GetUsage(ctx context.Context, userID string) (int64, int, error) {
    v, _ := q.entries.LoadOrStore(userID, &quotaEntry{})
    e := v.(*quotaEntry)
    e.mu.Lock()
    defer e.mu.Unlock()
    if q.now().After(e.expiresAt) {
        total, count, err := s3UsageProbe(ctx, q.store, userID)
        if err != nil {
            return 0, 0, err
        }
        e.usageBytes = total
        e.blobCount = count
        e.expiresAt = q.now().Add(QUOTA_CACHE_TTL)
    }
    return e.usageBytes, e.blobCount, nil
}
```

`MemStore` requires no changes — `MemStore` implements `Store`, not
`MediaQuotaStore`. Tests construct the quota directly: `NewMediaQuota(NewMemStore())`.

### 3. `server/handlers.go` — new handler

```go
// GET /v1/store/usage
func handleStoreUsage(quota MediaQuotaStore) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        userID := userIDFrom(r.Context())
        used, count, err := quota.GetUsage(r.Context(), userID)
        if err != nil {
            internalError(w, "GetUsage failed")
            return
        }
        writeJSON(w, http.StatusOK, map[string]any{
            "used_bytes":     used,
            "quota_bytes":    USER_MEDIA_QUOTA_BYTES,
            "blob_count":     count,
            "quota_blob_cap": USER_MEDIA_BLOB_CAP,
        })
    }
}
```

Handler does not need `Store` — only the quota interface.

### 4. `server/routes.go` — share the quota instance

```go
quota := NewMediaQuota(store)
// ...
mux.HandleFunc("POST /v1/store/presign", auth(handleStorePresign(store, quota)))
mux.HandleFunc("GET /v1/store/usage", auth(handleStoreUsage(quota)))
```

Sharing one instance is essential — otherwise the usage endpoint reads a
different cache than `ReserveUpload` writes, and uploads + reads see
inconsistent counts.

### 5. `server/handlers_test.go` — endpoint tests

Reuse `testServer`, `registerTestUser`, `authedRequest`. Required cases:

| Test | Setup | Assert |
|---|---|---|
| `TestStoreUsageGolden` | register user, put 2 objects under `media/{uid}/` | 200; `used_bytes == sum of sizes`; `blob_count == 2`; `quota_bytes == 1<<30`; `quota_blob_cap == 1000` |
| `TestStoreUsageUnauthenticated` | no token | 401 |
| `TestStoreUsageEmpty` | registered user with no media | 200; `used_bytes == 0`; `blob_count == 0` |
| `TestStoreUsageSharesQuotaCache` | `ReserveUpload` once, then GET usage | usage reflects the reserve (proves same instance is wired) |

Cross-user denial is not applicable — endpoint takes no prefix/key, always
returns the caller's own usage.

### 6. `web/src/lib/api.ts` — typed wrapper

Use the existing `request<T>` helper (not `apiFetch`):

```ts
export interface StorageUsage {
    used_bytes: number;
    quota_bytes: number;
    blob_count: number;
    quota_blob_cap: number;
}

export function getStorageUsage(token: string): Promise<StorageUsage> {
    return request('GET', '/v1/store/usage', { token });
}
```

### 7. `web/src/lib/utils.ts` — byte formatter

```ts
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(0)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(gb < 10 ? 2 : 1)} GB`;
}
```

Colocated test `utils.test.ts` (file does not exist yet — create it):

| Input | Expected |
|---|---|
| 0 | "0 B" |
| 1023 | "1023 B" |
| 1024 | "1 KB" |
| 500 \* 1024 | "500 KB" |
| 1024 \* 1024 | "1.0 MB" |
| 12 \* 1024 \* 1024 | "12 MB" |
| 1 << 30 | "1.00 GB" |
| 12 \* (1 << 30) | "12.0 GB" |

### 8. `web/src/hooks/useStorageUsage.ts` — new hook

Pattern matches [useDevices.ts](../web/src/hooks/useDevices.ts).

```ts
import { useEffect, useState } from 'react';
import { getStorageUsage, type StorageUsage } from '@/lib/api';

export interface StorageUsageState {
    usage: StorageUsage | null;
    loading: boolean;
    error: string | null;
}

export function useStorageUsage(token: string): StorageUsageState {
    const [usage, setUsage] = useState<StorageUsage | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        getStorageUsage(token)
            .then((u) => { if (!cancelled) setUsage(u); })
            .catch((e) => {
                if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load usage');
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [token]);

    return { usage, loading, error };
}
```

Colocated test `useStorageUsage.test.ts`: happy-dom + `vi.stubGlobal('fetch', …)`
(see [useConversations.test.ts](../web/src/hooks/useConversations.test.ts) for
the fetch-mocking pattern). Cases: loading→loaded transition; fetch error sets
`error` and leaves `usage` null.

### 9. `web/src/components/StorageIndicator.tsx` — pure component

```tsx
import { formatBytes } from '@/lib/utils';
import type { StorageUsage } from '@/lib/api';

interface Props {
    usage: StorageUsage | null;
    loading: boolean;
}

export function StorageIndicator({ usage, loading }: Props) {
    if (loading) {
        return <div className="text-sm text-muted-foreground">Loading storage usage…</div>;
    }
    if (!usage) return null;

    const pct = usage.used_bytes / usage.quota_bytes;
    const warn = pct >= 0.9;
    return (
        <div className={warn ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
            Storage: {formatBytes(usage.used_bytes)} / {formatBytes(usage.quota_bytes)} ({usage.blob_count} files)
            {warn && <span className="ml-2">Approaching storage limit.</span>}
        </div>
    );
}
```

### 10. `web/src/components/StorageIndicator.stories.tsx` — stories

States to cover:

| Story | Args |
|---|---|
| `Loading` | `loading: true, usage: null` |
| `EmptyUsage` | `loading: false, usage: { used_bytes: 0, quota_bytes: 1<<30, blob_count: 0, quota_blob_cap: 1000 }` |
| `SubMegabyte` | `used_bytes: 320 * 1024` (verifies KB rendering) |
| `Typical` | `used_bytes: 320 * 1024 * 1024` (~320 MB) |
| `Warning` | `used_bytes: 0.95 * (1<<30)` (≥90% → destructive colour + message) |
| `AtQuota` | `used_bytes: 1<<30` (100%) |

Verify both light and dark mode in Storybook.

### 11. `web/src/routes/settings.tsx` — wire it

Place above `<DeviceSettings>` in the `<ProfileSettings>` `children` slot:

```tsx
const storage = useStorageUsage(session.token);
// ...
<ProfileSettings handle={session.handle} token={session.token}>
    <StorageIndicator usage={storage.usage} loading={storage.loading} />
    <DeviceSettings ... />
</ProfileSettings>
```

## Cache staleness — known and acceptable

The reported usage can lag by up to `QUOTA_CACHE_TTL` (10 min) after a
successful upload, since `ReserveUpload` increments optimistically and the
cache is rebuilt from S3 only on expiry. A user uploading a file and
immediately opening settings will see the new value (same cache); a user
who took an action that *reduced* usage (none exist in v0.1 — there's no
delete UI yet) might see stale data. Not a bug — document and move on.
GC work will revisit this.

## Verify

- `cd server && go test ./...` — `TestStoreUsage*` cases pass.
- `make lint test` — TS + architecture lint pass; `formatBytes` and
  `useStorageUsage` unit tests pass.
- Storybook (`make web-storybook` on `:6006`) — all six `StorageIndicator`
  stories render correctly in light and dark mode.
- `make dev` → register a user → upload a small file → open Settings →
  indicator shows the size and count, formatter picks an appropriate unit.
- Hit 90% by uploading enough media (or manually setting a high
  `used_bytes` in a test) → warning colour + "Approaching storage limit"
  appears.
