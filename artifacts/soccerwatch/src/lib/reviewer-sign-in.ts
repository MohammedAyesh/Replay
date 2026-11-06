export const REVIEWER_SIGN_IN_ERROR =
  "This reviewer link has expired or was already used. Ask Replay for a new one.";

export type TicketSignInAttempt = {
  status: string | null;
  createdSessionId?: string | null;
};

export async function completeReviewerSignIn(
  token: string,
  createTicketSignIn: (token: string) => Promise<TicketSignInAttempt>,
  activateSession: (sessionId: string) => Promise<void>,
): Promise<void> {
  try {
    const attempt = await createTicketSignIn(token);
    if (attempt.status !== "complete" || !attempt.createdSessionId) {
      throw new Error(REVIEWER_SIGN_IN_ERROR);
    }
    await activateSession(attempt.createdSessionId);
  } catch {
    throw new Error(REVIEWER_SIGN_IN_ERROR);
  }
}
