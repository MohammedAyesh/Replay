import { matchTeamSpansTable } from "./matchRooms";

/**
 * Addendum name for the existing Part 1 table.  Keep one physical table so
 * deployments with migration 0033 remain compatible.
 */
export const matchPlayerTeamSpansTable = matchTeamSpansTable;
export type MatchPlayerTeamSpan = typeof matchPlayerTeamSpansTable.$inferSelect;