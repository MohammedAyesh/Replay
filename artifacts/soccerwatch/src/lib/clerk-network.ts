const CLERK_SESSION_TOUCH_PATH = /\/v1\/client\/sessions\/[^/]+\/touch\?/;

export function isTransientClerkSessionTouchError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  return (
    message.startsWith('ClerkJS: Network error at "https://') &&
    CLERK_SESSION_TOUCH_PATH.test(message) &&
    message.includes("TypeError: Failed to fetch")
  );
}