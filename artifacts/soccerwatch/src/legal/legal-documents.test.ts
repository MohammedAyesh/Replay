import { describe, expect, it } from "vitest";
import { privacy } from "./privacy";
import { terms } from "./terms";
import type { LegalDoc } from "./types";

const documents = { privacy, terms };
const supportedPlaceholders = new Set(["{{COMPANY}}", "{{SUPPORT_EMAIL}}"]);

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