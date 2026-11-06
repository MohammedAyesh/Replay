import { describe, expect, it, vi } from "vitest";
import {
  completeReviewerSignIn,
  reviewerSignInReadiness,
  REVIEWER_SIGN_IN_ALREADY_AUTHENTICATED,
  REVIEWER_SIGN_IN_ERROR,
} from "./reviewer-sign-in";

describe("reviewer sign-in ticket flow", () => {
  it("waits until Clerk is loaded and sign-in is available", () => {
    expect(reviewerSignInReadiness({
      isLoaded: false,
      isSignedIn: false,
      hasSignIn: true,
    })).toBe("waiting");
    expect(reviewerSignInReadiness({
      isLoaded: true,
      isSignedIn: false,
      hasSignIn: false,
    })).toBe("waiting");
  });

  it("does not consume a ticket when the browser is already signed in", () => {
    expect(reviewerSignInReadiness({
      isLoaded: true,
      isSignedIn: true,
      hasSignIn: true,
    })).toBe("already-signed-in");
    expect(REVIEWER_SIGN_IN_ALREADY_AUTHENTICATED)
      .toBe("You're already signed in. Open this link in a private window.");
  });

  it("starts ticket sign-in only when Clerk is ready and signed out", () => {
    expect(reviewerSignInReadiness({
      isLoaded: true,
      isSignedIn: false,
      hasSignIn: true,
    })).toBe("ready");
  });

  it("shows the same generic message when Clerk rejects an invalid token", async () => {
    const createTicketSignIn = vi.fn().mockRejectedValue(new Error("Clerk token details must not be shown"));
    const activateSession = vi.fn();

    await expect(
      completeReviewerSignIn("invalid-token", createTicketSignIn, activateSession),
    ).rejects.toThrow(REVIEWER_SIGN_IN_ERROR);
    expect(activateSession).not.toHaveBeenCalled();
  });

  it("activates a completed ticket session", async () => {
    const createTicketSignIn = vi.fn().mockResolvedValue({
      status: "complete",
      createdSessionId: "session-for-test",
    });
    const activateSession = vi.fn().mockResolvedValue(undefined);

    await completeReviewerSignIn("single-use-token", createTicketSignIn, activateSession);
    expect(createTicketSignIn).toHaveBeenCalledWith("single-use-token");
    expect(activateSession).toHaveBeenCalledOnce();
  });
});
