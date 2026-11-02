import { describe, expect, it } from "vitest";
import { chatIdForPhone, formatPhoneForDisplay, normalizePhone, phoneFromChatId } from "./phone";
import {
  AUTOMATIONS,
  effectiveAutomation,
  effectiveAutomations,
  formatFils,
  renderTemplate,
} from "./templates";
import { joinNames, mergeByPhone, type Recipient } from "./recipients";
import { bareMessageId } from "./waha";

describe("normalizePhone", () => {
  it.each([
    ["0791234567", "962791234567"],
    ["079 123 4567", "962791234567"],
    ["+962 79 123 4567", "962791234567"],
    ["00962791234567", "962791234567"],
    ["791234567", "962791234567"],
    ["9620791234567", "962791234567"],
    ["٠٧٩١٢٣٤٥٦٧", "962791234567"],
    ["+44 7700 900123", "447700900123"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each(["", null, "12345", "0612345678", "96261234", "abc"])("rejects %s", (raw) => {
    expect(normalizePhone(raw as string | null)).toBeNull();
  });

  it("round-trips through a chat id", () => {
    expect(phoneFromChatId(chatIdForPhone("962791234567"))).toBe("962791234567");
    expect(phoneFromChatId("962791234567:12@s.whatsapp.net")).toBe("962791234567");
    expect(phoneFromChatId("12036302@g.us")).toBe("12036302");
    // A linked id is not a phone number.
    expect(phoneFromChatId("99988877766655@lid")).toBeNull();
    expect(formatPhoneForDisplay("962791234567")).toBe("+962 79 123 4567");
  });
});

describe("templates", () => {
  it("fills placeholders, drops unknown ones and tidies blank lines", () => {
    const out = renderTemplate("Hi {name}  👋\n{missing}\n\n\nBye {player}", { name: "", player: "Ali" });
    expect(out).toBe("Hi 👋\n\nBye Ali");
  });

  it("every automation's defaults only use its own placeholders", () => {
    for (const def of AUTOMATIONS) {
      for (const locale of ["ar", "en"] as const) {
        const used = [...def.template[locale].matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
        for (const key of used) expect(def.placeholders, `${def.key} ${locale} {${key}}`).toContain(key);
      }
    }
  });

  it("is off by default except announcements, and clamps timing", () => {
    const all = effectiveAutomations({}, "ar");
    expect(all.session_reminder.enabled).toBe(false);
    expect(all.announcement.enabled).toBe(true);
    expect(all.session_reminder.timing).toBe(3);
    const def = AUTOMATIONS.find((a) => a.key === "session_reminder")!;
    expect(effectiveAutomation(def, { timing: 999 }, "ar").timing).toBe(48);
    expect(effectiveAutomation(def, { audiences: ["coaches", "parents"] }, "ar").audiences).toEqual(["coaches", "parents"]);
    const fixed = AUTOMATIONS.find((a) => a.key === "registration_received")!;
    expect(effectiveAutomation(fixed, { audiences: ["parents"] }, "ar").audiences).toEqual([]);
  });

  it("uses a custom template when set and the locale default otherwise", () => {
    const def = AUTOMATIONS.find((a) => a.key === "absence_notice")!;
    expect(effectiveAutomation(def, {}, "en").template).toBe(def.template.en);
    expect(effectiveAutomation(def, { template: "  custom {player} " }, "en")).toMatchObject({ template: "custom {player}", customTemplate: true });
  });

  it("formats money in JOD", () => {
    expect(formatFils(35000, "en")).toBe("35 JOD");
    expect(formatFils(12500, "ar")).toBe("12.5 دينار");
  });
});

describe("recipients", () => {
  const r = (phone: string, role: Recipient["role"], playerId: number | null, playerName: string | null): Recipient => ({
    phone, role, playerId, playerName, name: null, squadId: null, squadName: null,
  });

  it("merges siblings under one phone and prefers the parent role", () => {
    const merged = mergeByPhone([
      r("962790000001", "parent", 1, "Ali"),
      r("962790000001", "parent", 2, "Omar"),
      r("962790000002", "coach", null, null),
      r("962790000002", "parent", 3, "Zaid"),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ playerNames: ["Ali", "Omar"], role: "parent" });
    expect(merged[1]).toMatchObject({ role: "parent", playerNames: ["Zaid"] });
  });

  it("joins names per language", () => {
    expect(joinNames(["Ali", "Omar", "Zaid"], "en")).toBe("Ali, Omar and Zaid");
    expect(joinNames(["علي", "عمر"], "ar")).toBe("علي وعمر");
  });
});

describe("message ids", () => {
  it("strips the WEBJS serialized prefix so acks match", () => {
    expect(bareMessageId("true_962791234567@c.us_3EB0ABC")).toBe("3EB0ABC");
    expect(bareMessageId("3EB0ABC")).toBe("3EB0ABC");
  });
});
