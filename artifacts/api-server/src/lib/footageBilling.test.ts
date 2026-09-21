import { describe, expect, it } from "vitest";
import { computeAmountFils, computeBillableHours } from "./footageBilling";

describe("footage billing", () => {
  it.each([
    [20 * 60, 1],
    [60 * 60, 1],
    [61 * 60, 2],
    [4 * 60 * 60, 4],
  ])("charges done requests by started hour: %s seconds -> %s hour(s)", (seconds, expected) => {
    expect(computeBillableHours("done", seconds)).toBe(expected);
  });

  it.each([
    [3601, 3600, 1],
    [1800, 7200, 1],
    [5400, 7200, 2],
  ])("charges partial requests with the grace period: %s delivered of %s requested -> %s hour(s)", (delivered, requested, expected) => {
    expect(computeBillableHours("partial", requested, delivered)).toBe(expected);
  });

  it("does not charge failed requests", () => {
    expect(computeBillableHours("failed", 3600, 3600)).toBe(0);
  });

  it("multiplies integer hours by the integer fils rate", () => {
    expect(computeAmountFils(2, 1000)).toBe(2000);
  });
});