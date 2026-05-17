# Storage-used indicator in settings

## Motivation

v0.1 ships without media GC. Orphan blobs and legitimate attachments both
count against the 1 GiB quota until account deletion. Without a visible
"storage used" figure, users have no way to notice pressure or act on it.

A minimal indicator gets ~80% of the value of shipping GC, for a fraction
of the effort, and is a useful building block for GC's UX later (the same
endpoint can show "X MB reclaimable").

## Current state

- `MediaQuotaStore` interface has only `ReserveUpload`. No read path is
  exposed.
- `s3UsageProbe(ctx, store, uid)` already exists in `media_quota.go` and
  returns `(totalBytes int64, count int, err error)` via `ListObjectSizes`.
- Constants in place: `USER_MEDIA_QUOTA_BYTES = 1 << 30` (1 GiB),
  `USER_MEDIA_BLOB_CAP = 1000`.
- No `/v1/storage/usage` endpoint exists (`routes.go`).
- `web/src/routes/settings.tsx` has no storage section.

## Change

### 1. `server/media_quota.go` — add `GetUsage` to the interface

```go
type MediaQuotaStore interface {
    ReserveUpload(ctx context.Context, userID string, bytes int64) (ok bool, reason string, err error)
    GetUsage(ctx context.Context, userID string) (usedBytes int64, blobCount int, err error)
}
```

Implement on `inProcessMediaQuota` — read from cache, refresh via
`s3UsageProbe` if expired (same TTL logic as `ReserveUpload`):

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

Update `store_mem.go` mock — `MemStore` wires `MediaQuotaStore`; add a
`GetUsage` stub that returns zeros (or a configurable field for tests).

### 2. `server/handlers.go` — new handler

```go
func handleStoreUsage(store Store, quota MediaQuotaStore) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        uid := r.Context().Value(ctxUserID).(string)
        used, count, err := quota.GetUsage(r.Context(), uid)
        if err != nil {
            writeError(w, errInternal)
            return
        }
        writeJSON(w, map[string]any{
            "used_bytes":     used,
            "quota_bytes":    USER_MEDIA_QUOTA_BYTES,
            "blob_count":     count,
            "quota_blob_cap": USER_MEDIA_BLOB_CAP,
        })
    }
}
```

### 3. `server/routes.go` — wire the route

```go
mux.HandleFunc("GET /v1/storage/usage", auth(handleStoreUsage(store, NewMediaQuota(store))))
```

Pass the same `MediaQuota` instance used by `handleStorePresign` to share
the cache — extract it as a local variable in `SetupRoutes` rather than
constructing a second one.

### 4. `web/src/lib/api.ts` — typed wrapper

```ts
export interface StorageUsage {
    used_bytes: number;
    quota_bytes: number;
    blob_count: number;
    quota_blob_cap: number;
}

export async function getStorageUsage(token: string): Promise<StorageUsage> {
    return apiFetch<StorageUsage>('/v1/storage/usage', { token });
}
```

### 5. `web/src/components/StorageIndicator.tsx` — new component

Display "Storage: 340 MB / 1 GB (12 files)". Warn when `used_bytes /
quota_bytes >= 0.9`.

```tsx
interface Props {
    usage: StorageUsage | null;
    loading: boolean;
}

export function StorageIndicator({ usage, loading }: Props) {
    if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
    if (!usage) return null;

    const pct = usage.used_bytes / usage.quota_bytes;
    const warn = pct >= 0.9;
    const usedMB = (usage.used_bytes / (1024 * 1024)).toFixed(0);
    const quotaGB = (usage.quota_bytes / (1024 * 1024 * 1024)).toFixed(0);

    return (
        <div className={warn ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
            Storage: {usedMB} MB / {quotaGB} GB ({usage.blob_count} files)
            {warn && <span className="ml-2">Approaching storage limit.</span>}
        </div>
    );
}
```

Add a Storybook story covering normal, warning (≥90%), and loading states.

### 6. `web/src/routes/settings.tsx` — wire it in

Fetch on mount (or on settings-screen open). One call per visit is cheap
enough; no polling or push channel needed.

```ts
const [usage, setUsage] = useState<StorageUsage | null>(null);
const [usageLoading, setUsageLoading] = useState(true);

useEffect(() => {
    getStorageUsage(session.token)
        .then(setUsage)
        .catch(() => setUsage(null))
        .finally(() => setUsageLoading(false));
}, [session.token]);
```

Render `<StorageIndicator usage={usage} loading={usageLoading} />` in the
settings layout.

## Verify

- `make test` — handler-level Go test: golden path returns correct JSON;
  401 when unauthenticated; other-user prefix denial.
- `make lint` — `tsc --noEmit` passes.
- Open settings screen: storage line appears, values are plausible.
- Manually set `used_bytes` close to quota in test to confirm warning colour.
