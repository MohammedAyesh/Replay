---
name: Bunny export proxy cancellation
description: Safe credential handling and cancellation behavior for proxied Bunny Storage exports.
---

For trusted Bunny Storage exports, send the Storage AccessKey only from the server and cancel the upstream HTTP response when the downstream client disconnects. Keep loopback Storage stand-ins limited to test mode. Do not attach Storage credentials to arbitrary remote URLs.

**Why:** A browser/player must never receive the Storage key, and abandoning a large media response must not leave the server draining the upstream file. A plain `fetch` body pipeline did not make the test origin observe a client abort reliably; the trusted HTTP transport must retain and destroy the upstream request/response.

**How to apply:** Use this for the server-side download/playback proxies, preserve Range and response headers, and verify both full and ranged responses plus a mid-stream disconnect using an isolated local origin.
