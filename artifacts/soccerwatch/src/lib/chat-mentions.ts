export type MentionPart = { text: string; phone: string | null };

/** Split "Hi @962795550003 ok" into plain text and mentions. */
export function splitMentions(text: string): MentionPart[] {
  return text.split(/(@\d{8,15})/g).filter((part) => part !== "").map((part) => {
    const phone = /^@(\d{8,15})$/.exec(part)?.[1] ?? null;
    return { text: part, phone };
  });
}
