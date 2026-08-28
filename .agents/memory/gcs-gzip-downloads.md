---
name: GCS gzip downloads
description: Preserving gzip bytes when reading compressed objects through the Google Cloud Storage Node client.
---

Google Cloud Storage downloads transparently decompress objects marked with `contentEncoding: gzip` by default. Use the download option `{ decompress: false }` whenever the raw compressed bytes are being forwarded with `Content-Encoding: gzip` or passed to a manual gunzip step.

**Why:** Forwarding the default decompressed buffer while retaining the gzip response header makes browsers reject the response as an invalid gzip stream, even though the API returns HTTP 200.

**How to apply:** When adding or changing object-storage download helpers, decide explicitly whether the caller needs decoded content or raw bytes and set the download option to match.