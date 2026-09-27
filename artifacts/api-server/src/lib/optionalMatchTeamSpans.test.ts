import { describe, expect, it } from "vitest";
import {
  isMissingMatchTeamSpansTable,
  readOptionalMatchTeamSpans,
} from "./optionalMatchTeamSpans";

describe("optional match team spans", () => {
  it("returns an empty span list when a read fails", async () => {
    await expect(readOptionalMatchTeamSpans("optionalReadTest", async () => {
      throw new Error("database unavailable");
    })).resolves.toEqual([]);
  });

  it("preserves successful reads", async () => {
    const spans = [{ id: 1 }];
    await expect(readOptionalMatchTeamSpans("successfulReadTest", async () => spans))
      .resolves.toBe(spans);
  });

  it("recognizes a missing match_team_spans relation through a wrapped database error", () => {
    const postgresError = Object.assign(
      new Error('relation "match_team_spans" does not exist'),
      { code: "42P01" },
    );
    const queryError = Object.assign(new Error("Query failed"), { cause: postgresError });
    expect(isMissingMatchTeamSpansTable(queryError)).toBe(true);
  });

  it("does not classify other missing relations or database errors as a missing span table", () => {
    expect(isMissingMatchTeamSpansTable(Object.assign(
      new Error('relation "match_players" does not exist'),
      { code: "42P01" },
    ))).toBe(false);
    expect(isMissingMatchTeamSpansTable(new Error("connection refused"))).toBe(false);
  });
});