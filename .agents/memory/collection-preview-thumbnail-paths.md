---
name: Collection preview thumbnail paths
description: Bunny collection preview metadata can use a separate preview video ID and custom thumbnail filename.
---

Collection preview URLs must preserve the exact selected Bunny path. The collection GUID is not necessarily the preview video's GUID, and database overrides can use a custom filename such as `thumbnail_<suffix>.jpg`. When proxying a collection preview, extract the preview video ID from the existing URL and forward that exact URL through the established Bunny proxy.

**Why:** Fabricating a thumbnail URL from the collection GUID or assuming `/thumbnail.jpg` can produce a proxy URL for an asset that does not exist, even though the original preview metadata was valid.

**How to apply:** Keep the database override precedence and null behavior unchanged; only wrap a non-null selected preview URL for browser delivery.