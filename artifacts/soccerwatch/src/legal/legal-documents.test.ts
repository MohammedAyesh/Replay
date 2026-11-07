import { describe, expect, it } from "vitest";
import { privacy } from "./privacy";
import { terms } from "./terms";
import type { LegalDoc } from "./types";

const documents = { privacy, terms };
const supportedPlaceholders = new Set([
  "{{COMPANY}}",
  "{{SUPPORT_EMAIL}}",
  "{{PRIVACY_POLICY}}",
  "{{ACCOUNT_DELETION}}",
]);

function collectText(doc: LegalDoc): string[] {
  return [
    doc.title,
    doc.lastUpdated,
    doc.draftNotice,
    ...doc.sections.flatMap((section) => [
      section.heading,
      ...section.paragraphs,
      ...(section.bullets ?? []),
      ...(section.paragraphsAfterBullets ?? []),
    ]),
  ];
}

describe("legal documents", () => {
  it("keeps the requested terms sections in order in both languages", () => {
    const expectedHeadings = {
      en: [
        "Filming",
        "Your account",
        "Your content",
        "Fields and academies",
        "Facebook and Instagram",
        "Not allowed",
        "Reporting",
        "Payments",
        "Availability",
        "Ending",
        "Changes to these terms",
        "Contact",
      ],
      ar: [
        "التصوير",
        "حسابك",
        "محتواك",
        "الملاعب والأكاديميات",
        "فيسبوك وإنستغرام",
        "المحتوى الممنوع",
        "الإبلاغ",
        "المدفوعات",
        "التوفر",
        "إنهاء الاستخدام",
        "التغييرات على هذه الشروط",
        "التواصل",
      ],
    };

    for (const locale of ["en", "ar"] as const) {
      expect(terms[locale].lastUpdated).toBe("2026-11-07");
      expect(terms[locale].draftNotice).toBe("");
      expect(terms[locale].sections.map((section) => section.heading)).toEqual(expectedHeadings[locale]);
    }
  });

  it("uses the support-email placeholder and includes both internal links", () => {
    const allLegalText = [...collectText(terms.en), ...collectText(terms.ar), ...collectText(privacy.en), ...collectText(privacy.ar)];
    expect(allLegalText.join("\n")).not.toContain("abilal@replayjo.com");
    for (const locale of ["en", "ar"] as const) {
      expect(terms[locale].sections.find((section) => section.heading === (locale === "en" ? "Facebook and Instagram" : "فيسبوك وإنستغرام"))?.paragraphs[0])
        .toContain("{{PRIVACY_POLICY}}");
      expect(terms[locale].sections.find((section) => section.heading === (locale === "en" ? "Facebook and Instagram" : "فيسبوك وإنستغرام"))?.paragraphs[0])
        .toContain("{{ACCOUNT_DELETION}}");
      expect(privacy[locale].sections.find((section) => section.heading === (locale === "en" ? "Facebook and Instagram (for fields)" : "فيسبوك وإنستغرام (للملاعب)"))?.paragraphs[0])
        .toContain("{{SUPPORT_EMAIL}}");
    }
  });

  it.each(Object.entries(documents))(
    "%s has matching English and Arabic section and bullet counts",
    (_name, localizedDocs) => {
      expect(localizedDocs.ar.sections).toHaveLength(localizedDocs.en.sections.length);
      expect(localizedDocs.ar.sections.map((section) => section.bullets?.length ?? 0))
        .toEqual(localizedDocs.en.sections.map((section) => section.bullets?.length ?? 0));
    },
  );

  it.each(Object.entries(documents))(
    "%s contains only supported placeholders",
    (_name, localizedDocs) => {
      for (const doc of Object.values(localizedDocs)) {
        for (const text of collectText(doc)) {
          const placeholders = [...text.matchAll(/\{\{[^{}]*\}\}/g)].map(([placeholder]) => placeholder);
          expect(placeholders.every((placeholder) => supportedPlaceholders.has(placeholder))).toBe(true);
        }
      }
    },
  );
});