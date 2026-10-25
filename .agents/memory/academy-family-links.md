---
name: Academy family links
description: Expiry and revocation behavior for academy family invitation links.
---

Academy family links expire 90 days after issuance. Rotating a link invalidates the old token and removes guardian grants created through that token.

**Why:** The user specified this policy to make link rotation renew access while immediately revoking access derived from the prior invite.

**How to apply:** Enforce expiry when claiming a link and remove link-created grants transactionally when issuing its replacement.
