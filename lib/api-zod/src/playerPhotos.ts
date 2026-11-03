/**
 * Players' photoshoot uploads (academy console → Players → bulk upload): which
 * player a file is for, from the shirt number in its name. Shared by the
 * console's review list and the API.
 */


/**
 * The shirt number a photoshoot file is named after: "7.png", "07-omar.png",
 * "#10.png", "No 9 - Laith.webp", "player_11.png". The first standalone 1–2
 * digit number in the name; null when there is none (or it is above 99).
 */
export function shirtNumberFromFileName(name: string): number | null {
  const base = name.replace(/\\/g, "/").split("/").pop()!.replace(/\.[a-z0-9]{2,5}$/i, "");
  const m = /(?:^|[^0-9])0*(\d{1,2})(?![0-9])/.exec(base);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 99 ? n : null;
}

/**
 * Match each file to an active player by shirt number. A number nobody wears,
 * or that two players wear, is left unmatched (the owner picks in the review).
 */
export function matchShootFiles(
  files: string[],
  players: Array<{ id: number; jerseyNumber: number | null; isActive?: boolean }>,
): Array<{ file: string; number: number | null; playerId: number | null; reason: "matched" | "no-number" | "no-player" | "ambiguous" }> {
  const byNumber = new Map<number, number[]>();
  for (const p of players) {
    if (p.isActive === false || p.jerseyNumber === null || p.jerseyNumber === undefined) continue;
    byNumber.set(p.jerseyNumber, [...(byNumber.get(p.jerseyNumber) ?? []), p.id]);
  }
  return files.map((file) => {
    const number = shirtNumberFromFileName(file);
    if (number === null) return { file, number, playerId: null, reason: "no-number" as const };
    const who = byNumber.get(number) ?? [];
    if (who.length === 1) return { file, number, playerId: who[0], reason: "matched" as const };
    return { file, number, playerId: null, reason: who.length ? "ambiguous" as const : "no-player" as const };
  });
}
