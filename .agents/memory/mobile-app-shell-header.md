---
name: Mobile app-shell header positioning
description: Positioning guidance for persistent headers in mobile app shells with dynamic browser chrome.
---

Keep mobile app-shell headers in normal layout flow and use sticky positioning when they need to remain visible. Avoid removing the header from flow with fixed positioning unless the layout reserves its full occupied space and accounts for dynamic browser viewport insets.

**Why:** On iOS browser previews, the fixed header's safe-area offset and the page content did not move together as browser chrome appeared, leaving content behind the browser controls.

**How to apply:** For app-shell pages that scroll internally, keep the header as a flex sibling of the scroll area. For document-scrolling routes, use sticky positioning and verify with mobile browser chrome expanded and collapsed.
