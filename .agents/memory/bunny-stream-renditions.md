---
name: Bunny Stream renditions and fallback
description: Bunny encoding prerequisites for manual quality choices and MP4 fallback playback.
---

Configure desired output resolutions in the Bunny Stream library's Encoding settings before upload. Bunny describes adaptive renditions as automatic, while custom players must use the variants exposed in the HLS manifest. One resolution label in the UI is not proof that Bunny encoded no other renditions; inspect the manifest and browser codec support. Bunny generates MP4 fallback files only for videos encoded after the setting is enabled; existing videos need retained originals to be re-encoded.

**Why:** UI code cannot add missing Bunny renditions or create an MP4 fallback file, but player-visible levels do not by themselves reveal every rendition Bunny may have encoded. Extra resolutions also increase encoding work and storage.

**How to apply:** Before debugging a missing quality option, inspect the actual master playlist and levels accepted by the browser rather than inferring encoding status from the button label. For MP4 fallback, verify that the library setting was enabled before the video was encoded.