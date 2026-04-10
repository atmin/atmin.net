# Large media (chunked encryption + streaming playback)

v0.1 encrypts files as a single AES-256-GCM blob. This works for photos and small files
but breaks down at ~100MB+: `crypto.subtle.encrypt` is not streaming (entire plaintext +
ciphertext in memory), upload can't resume on failure, and playback requires full download.

**Chunked encryption** solves all three:

1. Split file into fixed-size chunks (e.g. 5MB).
2. Encrypt each: `AES-256-GCM(key, nonce = base_iv || uint32(chunk_index), chunk)`.
3. Upload via S3 multipart upload — one encrypted chunk per part. Failed part = retry that part.
4. Final S3 object is a single blob of concatenated encrypted chunks.

Each encrypted chunk is `chunk_size + 16` bytes (GCM auth tag).

**Streaming playback**: recipient fetches via HTTP Range requests aligned to
encrypted chunk boundaries, decrypts chunk-by-chunk, feeds to MediaSource Extensions (MSE).
Playback starts after the first chunk.

**Message format** is forward-compatible — presence of `chunk_size` signals chunked mode:

```json
{
  "type": "media",
  "body": "video.mp4",
  "file": {
    "url": "media/alice01/<sha256>/video.mp4",
    "key": "<base64 AES-256-GCM key>",
    "base_iv": "<base64 8-byte>",
    "chunk_size": 5242880,
    "size": 1073741824,
    "sha256": "<hex of plaintext>"
  }
}
```

Absence of `chunk_size` = single-blob mode (v0.1 path). No migration needed.
