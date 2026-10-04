export interface GuardianContactLinks {
  whatsappUrl: string;
  callUrl: string;
}

export function guardianContactLinks(phone: string | null | undefined): GuardianContactLinks | null {
  if (!phone?.trim()) return null;

  const rawDigits = phone.replace(/\D/g, "");
  const digits = rawDigits.startsWith("00") ? rawDigits.slice(2) : rawDigits;
  const internationalDigits = digits.startsWith("0")
    ? `962${digits.slice(1)}`
    : digits;

  if (internationalDigits.length < 8 || internationalDigits.length > 15) return null;

  return {
    whatsappUrl: `https://wa.me/${internationalDigits}`,
    callUrl: `tel:+${internationalDigits}`,
  };
}