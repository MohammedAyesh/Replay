import { describe, expect, it } from "vitest";
import {
  answerNarrowing,
  groupDenseCrossings,
  nextNarrowingQuestion,
  startNarrowing,
} from "./claim-match-engine";

describe("claim match narrowing", () => {
  it("asks about the middle crossing and halves later on yes", () => {
    const state = startNarrowing([10, 20, 30, 40], 0, 50);
    const question = nextNarrowingQuestion(state);
    expect(question.kind).toBe("question");
    expect(question.momentSeconds).toBe(30);

    const next = answerNarrowing(state, "yes", question.momentSeconds);
    expect(next.lowerSeconds).toBe(30);
    expect(next.upperSeconds).toBe(50);
    expect(next.crossings).toEqual([40]);
    expect(next.questionCount).toBe(1);
  });

  it("keeps the earlier half on no and does not advance on not sure", () => {
    const state = startNarrowing([10, 20, 30, 40], 0, 50);
    const question = nextNarrowingQuestion(state);
    const unsure = answerNarrowing(state, "not-sure", question.momentSeconds);
    expect(unsure).toEqual(state);

    const earlier = answerNarrowing(state, "no", question.momentSeconds);
    expect(earlier.upperSeconds).toBe(30);
    expect(earlier.crossings).toEqual([10, 20, 30]);
    expect(earlier.questionCount).toBe(1);
  });

  it("goes to a picker after three answers or one crossing", () => {
    const state = startNarrowing([10, 20, 30, 40], 0, 50);
    const capped = { ...state, questionCount: 3 };
    expect(nextNarrowingQuestion(capped).kind).toBe("picker");
    expect(nextNarrowingQuestion({ ...state, crossings: [22] }).kind).toBe("picker");
  });

  it("groups dense mistakes into one passage", () => {
    expect(groupDenseCrossings([10, 11, 12, 25, 30, 31])).toEqual([11, 30]);
  });
});