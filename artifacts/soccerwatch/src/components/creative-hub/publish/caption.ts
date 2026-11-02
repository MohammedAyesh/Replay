import type { CreativeData } from "@workspace/api-zod";

/**
 * A suggested caption from the project's own data (score, opponent, player…),
 * in Ammani Arabic by default, ending with the academy's hashtag. The owner
 * edits it before anything is posted.
 */
export function suggestCaption(data: CreativeData | null | undefined, hashtag: string | null, locale: "ar" | "en" = "ar"): string {
  const ar = locale === "ar";
  const lines: string[] = [];
  const m = data?.match;
  const own = m?.ownName || data?.academy?.nameAr || data?.academy?.name || "";
  if (m && typeof m.ownScore === "number" && typeof m.opponentScore === "number") {
    lines.push(ar ? `صافرة النهاية ⚽ ${own} ${m.ownScore} - ${m.opponentScore} ${m.opponent ?? ""}`.trim()
      : `Full time ⚽ ${own} ${m.ownScore} - ${m.opponentScore} ${m.opponent ?? ""}`.trim());
    const diff = m.ownScore - m.opponentScore;
    lines.push(diff > 0 ? (ar ? "مبروك للشباب! 💪" : "Well played, lads! 💪")
      : diff === 0 ? (ar ? "تعادل… والجاي أحلى 🤝" : "A draw. Next one's ours 🤝")
        : (ar ? "راسنا مرفوع، والجاي إلنا 💙" : "Heads up. We go again 💙"));
    if (m.scorers) lines.push(ar ? `⚽ الأهداف: ${m.scorers}` : `⚽ Goals: ${m.scorers}`);
  } else if (m && (m.opponent || m.date)) {
    lines.push(ar ? `يوم المباراة 🔥 ${own}${m.opponent ? ` ضد ${m.opponent}` : ""}` : `Matchday 🔥 ${own}${m.opponent ? ` vs ${m.opponent}` : ""}`);
    const when = [m.date, m.time].filter(Boolean).join(" · ");
    const where = [m.place, when].filter(Boolean).join(" · ");
    if (where) lines.push(`📍 ${where}`);
    lines.push(ar ? "تعالوا شجّعوا! 📣" : "Come and support! 📣");
  } else if (data?.player?.name) {
    const p = data.player;
    lines.push(`⭐ ${p.name}${p.number ? ` #${p.number}` : ""}`);
    lines.push(ar ? "من ملاعبنا 📸" : "From our pitch 📸");
  } else {
    lines.push(ar ? "من ملاعبنا 📸" : "From our pitch 📸");
  }
  if (m?.competition) lines.push(`🏆 ${m.competition}${m.stage ? ` · ${m.stage}` : ""}`);
  const tags = [hashtag, ar ? "#كرة_قدم" : "#football"].filter(Boolean).join(" ");
  return `${lines.join("\n")}\n\n${tags}`.trim();
}
