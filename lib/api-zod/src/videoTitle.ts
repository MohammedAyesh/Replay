export type FormatCVideoTitle = {
  cameraNumber: number;
  date: string;
  time: string;
};

/**
 * Machine-readable title used for footage requested from the owner console.
 * The start date/time is intentional for windows that cross midnight.
 */
export function buildOwnerFootageTitle(
  cameraId: string,
  requestId: number,
  startLocal: string,
): string {
  const cameraNumber = cameraId.match(/(?:cam(?:era)?[-_]?)(\d+)$/i)?.[1] ?? "1";
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(startLocal);
  if (!match) throw new Error("Invalid owner footage start time");
  return `cam${cameraNumber}_owner-${requestId}_${match[1]}_${match[2]}`;
}

export function parseFormatCVideoTitle(title: string): FormatCVideoTitle | null {
  const parts = title.replace(/\.\w+$/, "").split("_");
  const camera = /^cam(\d+)$/i.exec(parts[0] ?? "");
  const date = parts.at(-2);
  const time = parts.at(-1);
  if (!camera || !date || !time || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(time)) {
    return null;
  }
  const [hour, minute] = time.split(":").map(Number);
  if (hour > 23 || minute > 59) return null;
  return { cameraNumber: Number(camera[1]), date, time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}