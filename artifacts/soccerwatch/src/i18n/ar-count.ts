/**
 * Arabic counting, the way a player in Amman would say it: 1 and 2 have their
 * own words ("لمسة وحدة", "لمستين"), 3–10 (and 0) take the plural ("5 لمسات"),
 * 11 and up and any fraction take the singular ("15 لمسة"). Digits stay Latin.
 */
export const arCount = (n: number, one: string, two: string, few: string, many: string): string =>
  n === 1 ? one : n === 2 ? two : Number.isInteger(n) && n >= 0 && n <= 10 ? `${n} ${few}` : `${n} ${many}`;
