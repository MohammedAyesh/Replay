export type LegalDoc = {
  title: string;
  lastUpdated: string;
  draftNotice: string;
  sections: {
    heading: string;
    paragraphs: string[];
    bullets?: string[];
  }[];
};