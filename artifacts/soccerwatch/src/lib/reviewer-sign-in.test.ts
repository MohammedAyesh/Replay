import { describe, expect, it, vi } from "vitest";
import { completeReviewerSignIn, REVIEWER_SIGN_IN_ERROR } from "./reviewer-sign-in";

describe("reviewer sign-in ticket flow", () => {
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
    expect(activateSession).toHaveBeenCalledWith("session-for-test");
  });
});
