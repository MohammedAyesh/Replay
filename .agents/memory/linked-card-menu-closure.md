---
name: Menus inside linked cards
description: Radix menu dismissal behavior when report/block menus are embedded in clickable card links.
---

When a Radix dropdown lives inside a clickable card link, stop propagation and prevent the default link action on the trigger and menu content. A menu item's `onSelect` calling `preventDefault()` also cancels Radix's automatic dismissal, so explicitly control the menu's open state and close it before opening a sheet or dialog.

**Why:** The safety actions must not navigate to the card destination, and leaving the dropdown open beneath a report sheet or block confirmation creates conflicting overlays.

**How to apply:** Use this for clip/profile action menus nested inside linked cards whenever selecting an item must suppress anchor navigation and open a separate overlay.