import { BRANDING_PRESETS, loadLocalImage, presetCrestPath } from "./assets";
import type { BrandLook } from "./types";

const HEX = /^#[0-9a-fA-F]{6}$/;
export const DEMO_DEFAULT_COLOR = "#D4FF4F";

/**
 * The look the public demo shows: the bundled Jordan Galaxy preset, or a
 * prospect's typed name and colour with an initials crest.
 */
export async function demoBrandLook(input: {
  look: "galaxy" | "custom";
  name: string;
  color: string;
  persona: "pitch" | "academy";
}): Promise<BrandLook> {
  if (input.look === "galaxy") {
    const preset = BRANDING_PRESETS.find((entry) => entry.key === "jordan-galaxy");
    if (!preset) throw new Error("Jordan Galaxy branding preset is missing");
    const crest = await loadLocalImage(presetCrestPath(preset));
    if (!crest) throw new Error("Jordan Galaxy crest could not be loaded");
    return {
      nameEn: preset.nameEn,
      nameAr: preset.nameAr,
      taglineAr: preset.taglineAr,
      primaryColor: preset.primaryColor,
      accentColor: preset.accentColor,
      bookingPhone: preset.bookingPhone,
      instagram: preset.instagram,
      crest,
      isAcademy: input.persona === "academy",
    };
  }

  const name = input.name.trim().slice(0, 28) || "YOUR PITCH";
  const hasArabic = /[؀-ۿ]/u.test(name);
  return {
    nameEn: hasArabic ? "" : name,
    nameAr: hasArabic ? name : null,
    taglineAr: null,
    primaryColor: HEX.test(input.color) ? input.color.toUpperCase() : DEMO_DEFAULT_COLOR,
    accentColor: null,
    bookingPhone: null,
    instagram: null,
    crest: null,
    isAcademy: input.persona === "academy",
  };
}
