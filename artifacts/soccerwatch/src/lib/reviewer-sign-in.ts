export const REVIEWER_SIGN_IN_ERROR =
  "This reviewer link has expired or was already used. Ask Replay for a new one.";
export const REVIEWER_SIGN_IN_ALREADY_AUTHENTICATED =
  "You're already signed in. Open this link in a private window.";

export type ReviewerSignInReadiness = "waiting" | "already-signed-in" | "ready";

export function reviewerSignInReadiness({
  isLoaded,
  isSignedIn,
  hasSignIn,
}: {
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  hasSignIn: boolean;
}): ReviewerSignInReadiness {
  if (!isLoaded || !hasSignIn) return "waiting";
  return isSignedIn ? "already-signed-in" : "ready";
}

export type TicketSignInAttempt = {
  status: string | null;
  createdSessionId?: string | null;
};

export async function completeReviewerSignIn(
  token: string,
  createTicketSignIn: (token: string) => Promise<TicketSignInAttempt>,
  activateSession: () => Promise<void>,
): Promise<void> {
  try {
    const attempt = await createTicketSignIn(token);
    if (attempt.status !== "complete" || !attempt.createdSessionId) {
      throw new Error(REVIEWER_SIGN_IN_ERROR);
    }
    await activateSession();
  } catch {
    throw new Error(REVIEWER_SIGN_IN_ERROR);
  }
}
