import { describe, expect, it, vi } from "vitest";
import { retryAcademyFamilyClaim } from "./academy-family-claim";

describe("retryAcademyFamilyClaim", () => {
  it("retries the claim request and navigates after success", async () => {
    const claim = vi.fn().mockResolvedValue({ playerId: 42 });
    const navigate = vi.fn();

    await retryAcademyFamilyClaim("family-token", claim, navigate);
    await retryAcademyFamilyClaim("family-token", claim, navigate);

    expect(claim).toHaveBeenCalledTimes(2);
    expect(claim).toHaveBeenLastCalledWith("family-token");
    expect(navigate).toHaveBeenLastCalledWith("/academy/me?playerId=42");
  });

  it("leaves navigation unchanged and propagates a failed retry", async () => {
    const claim = vi.fn().mockRejectedValue(new Error("claim failed"));
    const navigate = vi.fn();

    await expect(retryAcademyFamilyClaim("family-token", claim, navigate)).rejects.toThrow("claim failed");
    expect(navigate).not.toHaveBeenCalled();
  });
});
