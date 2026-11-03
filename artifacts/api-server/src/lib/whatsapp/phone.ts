/**
 * Phone numbers for WhatsApp: digits only, international form, no "+".
 *
 * Numbers in the app are typed by owners and parents in every shape Jordan uses:
 * "0791234567", "079 123 4567", "+962 79 123 4567", "00962791234567", "791234567",
 * sometimes with Arabic-Indic digits. All of those become "962791234567".
 *
 * A number that already carries another country code (10–15 digits, not starting
 * with 0) is kept as written. Anything else is rejected rather than guessed.
 */
const ARABIC_INDIC = /[٠-٩]/g;
const EXTENDED_ARABIC_INDIC = /[۰-۹]/g;

export function toAsciiDigits(value: string): string {
  return value
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXTENDED_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0));
}

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = toAsciiDigits(raw).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);

  // Jordan mobile, local forms.
  if (/^07[789]\d{7}$/.test(digits)) return `962${digits.slice(1)}`;
  if (/^7[789]\d{7}$/.test(digits)) return `962${digits}`;
  // Jordan with a stray trunk zero after the country code: 9620791234567.
  if (/^96207[789]\d{7}$/.test(digits)) return `962${digits.slice(4)}`;
  if (/^9627[789]\d{7}$/.test(digits)) return digits;
  // A malformed Jordanian number is not another country's number.
  if (digits.startsWith("962")) return null;
  if (digits.startsWith("0")) return null;
  if (digits.length >= 10 && digits.length <= 15) return digits;
  return null;
}

/** WAHA chat id for a normalised phone. */
export function chatIdForPhone(phone: string): string {
  return `${phone}@c.us`;
}

/** Phone from a WAHA chat id ("962791234567@c.us", "962791234567@s.whatsapp.net"). */
export function phoneFromChatId(chatId: string | null | undefined): string | null {
  if (!chatId) return null;
  // "@lid" is WhatsApp's private linked id, not a phone number: resolve it with lidFromChatId + WAHA.
  if (isLid(chatId)) return null;
  const local = chatId.split("@")[0]?.split(":")[0] ?? "";
  return /^\d{8,15}$/.test(local) ? local : null;
}

/** WhatsApp hides many senders behind a linked id ("123456789012345@lid") instead of their number. */
export function isLid(chatId: string | null | undefined): boolean {
  return typeof chatId === "string" && /@lid$/i.test(chatId.trim());
}

/** "962791234567" → "+962 79 123 4567" for display. */
export function formatPhoneForDisplay(phone: string): string {
  if (/^9627\d{8}$/.test(phone)) return `+962 ${phone.slice(3, 5)} ${phone.slice(5, 8)} ${phone.slice(8)}`;
  return `+${phone}`;
}

// ─── Group chats: stored under the key "g:<groupId>" where a person's chat uses the phone ───

const GROUP_ID = /^\d{6,30}(-\d{6,15})?$/;

export function isGroupKey(key: string | null | undefined): boolean {
  return typeof key === "string" && key.startsWith("g:") && GROUP_ID.test(key.slice(2));
}

export function groupKey(groupId: string): string {
  return `g:${groupId.replace(/@g\.us$/, "")}`;
}

export function groupIdFromKey(key: string): string | null {
  return isGroupKey(key) ? key.slice(2) : null;
}

/** A chat key from a URL: a phone number (normalised) or a group key. */
export function chatKeyFromParam(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (isGroupKey(value)) return value;
  return normalizePhone(value);
}
