/**
 * The card a player posts: 1080 x 1350, drawn on a canvas so it needs no
 * server and no screenshot. It says only what the report says, with the
 * margin line at the bottom, and carries the match room's link.
 */

export type ShareCardInput = {
  brand: string;
  dateLine: string;
  teamA: string;
  teamB: string;
  score: string | null;
  heading: string;
  stats: Array<{ value: string; label: string; note: string | null }>;
  durationSeconds: number;
  spans: Array<[number, number]>;
  goals: Array<{ at: number; colour: string; mine: boolean }>;
  timelineCaption: string;
  link: string;
  precision: string;
  rtl: boolean;
};

const C = {
  void: "#0B0F1A",
  line: "#232C42",
  axis: "#3A4560",
  lime: "#D4FF4F",
  turf: "#2FD8C4",
  text: "#F2F4F8",
  muted: "#8A93A6",
};

async function fontsReady(rtl: boolean): Promise<void> {
  try {
    const fonts = document.fonts;
    if (!fonts) return;
    await Promise.all([
      fonts.load("700 112px Rajdhani"),
      fonts.load("600 24px Inter"),
      ...(rtl ? [fonts.load("800 56px Cairo"), fonts.load("500 24px Tajawal")] : []),
    ]);
  } catch {
    // Fall back to whatever the browser has; the card still reads.
  }
}

export async function drawShareCard(input: ShareCardInput): Promise<Blob> {
  await fontsReady(input.rtl);
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  const display = input.rtl ? "Cairo, Rajdhani, sans-serif" : "Rajdhani, Inter, sans-serif";
  const body = input.rtl ? "Tajawal, Inter, sans-serif" : "Inter, sans-serif";
  const numbers = "Rajdhani, Inter, sans-serif";
  const x0 = 80;
  const x1 = W - 80;
  const start = input.rtl ? x1 : x0;
  const align: CanvasTextAlign = input.rtl ? "right" : "left";

  ctx.fillStyle = C.void;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W, -135, 0, W, -135, 1200);
  glow.addColorStop(0, "rgba(47,216,196,.14)");
  glow.addColorStop(0.6, "rgba(47,216,196,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Brand and date.
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.turf;
  ctx.font = `700 28px ${numbers}`;
  ctx.textAlign = input.rtl ? "right" : "left";
  ctx.fillText(input.brand.toUpperCase().split("").join(String.fromCharCode(8202)), start, 110);
  ctx.fillStyle = C.muted;
  ctx.font = `600 22px ${display}`;
  ctx.textAlign = input.rtl ? "left" : "right";
  ctx.fillText(input.dateLine, input.rtl ? x0 : x1, 110);

  // Score line: team names never reorder the score, which is drawn LTR in the middle.
  ctx.textAlign = "left";
  ctx.font = `700 150px ${numbers}`;
  const scoreText = input.score ?? "–";
  const scoreWidth = ctx.measureText(scoreText).width;
  ctx.font = `700 56px ${display}`;
  const aWidth = ctx.measureText(input.teamA).width;
  let x = x0;
  const baseline = 330;
  ctx.fillStyle = C.text;
  ctx.fillText(input.teamA, x, baseline);
  x += aWidth + 28;
  ctx.font = `700 150px ${numbers}`;
  ctx.fillText(scoreText, x, baseline + 10);
  x += scoreWidth + 28;
  ctx.font = `700 56px ${display}`;
  ctx.fillStyle = C.muted;
  ctx.fillText(input.teamB, x, baseline);

  // Heading.
  ctx.textAlign = align;
  ctx.fillStyle = C.lime;
  ctx.font = `700 24px ${display}`;
  ctx.fillText(input.rtl ? input.heading : input.heading.toUpperCase(), start, 470);

  // Three numbers.
  const colW = (x1 - x0 - 64) / 3;
  input.stats.slice(0, 3).forEach((stat, index) => {
    const col = input.rtl ? 2 - index : index;
    const left = x0 + col * (colW + 32);
    const anchor = input.rtl ? left + colW : left;
    ctx.textAlign = input.rtl ? "right" : "left";
    ctx.fillStyle = C.text;
    ctx.font = `700 112px ${numbers}`;
    ctx.fillText(stat.value, anchor, 600);
    ctx.fillStyle = C.muted;
    ctx.font = `500 24px ${body}`;
    ctx.fillText(stat.label, anchor, 648);
    if (stat.note) {
      ctx.fillStyle = C.lime;
      ctx.font = `700 26px ${display}`;
      ctx.fillText(stat.note, anchor, 690);
    }
  });

  // Timeline, always LTR.
  const barTop = 800;
  const pct = (seconds: number) => x0 + (Math.min(Math.max(seconds, 0), input.durationSeconds) / Math.max(1, input.durationSeconds)) * (x1 - x0);
  const rounded = (left: number, top: number, width: number, height: number, radius: number) => {
    const w = Math.max(0, width);
    if (typeof ctx.roundRect !== "function") {
      ctx.fillRect(left, top, w, height);
      return;
    }
    ctx.beginPath();
    ctx.roundRect(left, top, w, height, Math.min(radius, w / 2));
    ctx.fill();
  };
  ctx.fillStyle = C.line;
  rounded(x0, barTop, x1 - x0, 16, 8);
  ctx.fillStyle = C.turf;
  for (const [a, b] of input.spans) rounded(pct(a), barTop, pct(b) - pct(a), 16, 2);
  ctx.fillStyle = C.muted;
  ctx.fillRect((x0 + x1) / 2 - 1, barTop - 6, 2, 28);
  for (const goal of input.goals) {
    const cx = pct(goal.at);
    ctx.beginPath();
    if (goal.mine) {
      ctx.arc(cx, barTop - 25, 12, 0, Math.PI * 2);
      ctx.fillStyle = C.void;
      ctx.fill();
      ctx.lineWidth = 5;
      ctx.strokeStyle = C.lime;
      ctx.stroke();
    } else {
      ctx.arc(cx, barTop - 25, 10, 0, Math.PI * 2);
      ctx.fillStyle = goal.colour;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = C.text;
      ctx.stroke();
    }
  }
  ctx.fillStyle = C.muted;
  ctx.font = `600 20px ${display}`;
  ctx.textAlign = "center";
  ctx.fillText(input.timelineCaption, W / 2, barTop + 56);

  // Link and the margin line.
  ctx.textAlign = align;
  ctx.fillStyle = C.text;
  ctx.font = `700 34px ${numbers}`;
  ctx.fillText(input.link, start, 1180);
  ctx.fillStyle = C.axis;
  ctx.font = `400 18px ${body}`;
  wrap(ctx, input.precision, start, 1230, x1 - x0, 26);

  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no blob"))), "image/png"));
}

function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, lineHeight: number) {
  const words = text.split(/\s+/);
  let line = "";
  let top = y;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) {
      ctx.fillText(line, x, top);
      line = word;
      top += lineHeight;
    } else {
      line = next;
    }
  }
  if (line) ctx.fillText(line, x, top);
}

/** Share the card as a file where the browser can; otherwise save it. */
export async function shareOrSaveCard(blob: Blob, filename: string, title: string): Promise<"shared" | "saved"> {
  const file = new File([blob], filename, { type: "image/png" });
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title });
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "shared";
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "saved";
}
