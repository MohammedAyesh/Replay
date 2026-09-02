---
name: Signup media consent
description: Product decision for collecting recording and social-media consent during account creation.
---

Recording consent belongs inline in the normal Clerk signup experience and is required before any signup action can continue. Social-media consent is a separate optional choice; when it is unchecked, the account must not be treated as eligible for social sharing. Do not redirect newly created users to a separate consent page.

**Why:** The signup-time choice is clearer and less disruptive than allowing account creation and then blocking the user behind a consent gate.

**How to apply:** Keep the consent choices with the signup form, pass them through the signup flow, and persist them when the local user is provisioned. Existing accounts should continue to load without being re-prompted.