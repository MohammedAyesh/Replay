import { logger } from "./logger";

const warnedOperations = new Set<string>();

function errorDetails(error: unknown): { messages: string[]; codes: string[] } {
  const messages: string[] = [];
  const codes: string[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (current instanceof Error) messages.push(current.message);
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);

    const value = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      originalError?: unknown;
    };
    if (typeof value.code === "string") codes.push(value.code);
    if (typeof value.message === "string" && !(current instanceof Error)) messages.push(value.message);
    if (value.cause !== undefined) pending.push(value.cause);
    if (value.originalError !== undefined) pending.push(value.originalError);
  }

  return { messages, codes };
}

function errorText(error: unknown): string {
  const { messages } = errorDetails(error);
  return messages[0] ?? String(error);
}

export function warnOptionalMatchTeamSpansFailureOnce(operation: string, error: unknown): void {
  if (warnedOperations.has(operation)) return;
  warnedOperations.add(operation);
  logger.warn(
    { operation, reason: errorText(error) },
    "Optional match team spans unavailable; continuing without spans",
  );
}

export async function readOptionalMatchTeamSpans<T>(
  operation: string,
  query: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await query();
  } catch (error) {
    warnOptionalMatchTeamSpansFailureOnce(operation, error);
    return [];
  }
}

export function isMissingMatchTeamSpansTable(error: unknown): boolean {
  const { messages, codes } = errorDetails(error);
  const mentionsTable = messages.some((message) => /match_team_spans/i.test(message));
  const missingRelation = codes.includes("42P01")
    || messages.some((message) => /relation .+ does not exist/i.test(message));
  return mentionsTable && missingRelation;
}