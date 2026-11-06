---
name: Clerk one-time ticket sign-in
description: Use the supported Clerk React hook flow for custom one-time ticket sign-in.
---

For custom one-time ticket sign-in in this app, use `useSignIn` from `@clerk/react`, call `signIn.create({ strategy: "ticket", ticket })`, verify the completed attempt and session ID, then activate it with `signIn.finalize()`. Avoid importing `useSignIn` from `@clerk/react/legacy`; that path showed an invalid-hook runtime error in the reviewer page, while the Core v3 hook rendered without it.

**Why:** This project uses Clerk's Core v3 signal-based React API, whose `SignInFuture` owns both ticket completion and session finalization.

**How to apply:** Use this flow for custom ticket-based sign-in pages. Keep token errors generic and remove the ticket from the address bar before invoking Clerk.
