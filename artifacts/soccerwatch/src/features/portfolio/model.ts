import type {
  PortfolioClip,
  PortfolioView,
  UpdatePortfolioInput,
} from "@workspace/api-client-react";

export type PortfolioHistoryItem = {
  id?: number;
  editorId: string;
  academy: string;
  startYear: number;
  endYear: number | null;
  current: boolean;
  role: string;
  displayOrder: number;
  accent: "lime" | "teal" | "violet";
};

export type PortfolioState = {
  name: string;
  age: number | null;
  nation: string;
  position: string;
  profilePhoto: string | null;
  history: PortfolioHistoryItem[];
};

export type PortfolioViewModel = PortfolioState & {
  id: number;
  followerCount: number;
  followingCount: number;
  clipCount: number;
  clips: PortfolioClip[];
  canEdit: boolean;
};

const ACCENTS = ["lime", "teal", "violet"] as const;

export function normalizeRole(value: string): string {
  return value.trim();
}

export function portfolioFromApi(view: PortfolioView): PortfolioViewModel {
  return {
    id: view.id,
    name: view.name,
    age: view.age,
    nation: view.nation ?? "",
    position: view.position ?? "",
    profilePhoto: view.profilePhoto,
    followerCount: view.followerCount,
    followingCount: view.followingCount,
    clipCount: view.clipCount,
    clips: view.clips,
    canEdit: view.canEdit,
    history: [...view.history]
      .sort((a, b) => a.displayOrder - b.displayOrder || a.id - b.id)
      .map((item, index) => ({
        id: item.id,
        editorId: `portfolio-history-${item.id}`,
        academy: item.teamName,
        role: normalizeRole(item.roleLabel),
        startYear: item.startYear,
        endYear: item.endYear,
        current: item.isCurrent,
        displayOrder: item.displayOrder,
        accent: ACCENTS[index % ACCENTS.length],
      })),
  };
}

export function portfolioToUpdateInput(value: PortfolioState): UpdatePortfolioInput {
  return {
    name: value.name.trim(),
    age: value.age,
    position: value.position.trim() || null,
    nation: value.nation.trim() || null,
    profilePhoto: value.profilePhoto,
    history: value.history.map((item, index) => ({
      teamName: item.academy.trim(),
      roleLabel: item.role.trim(),
      startYear: item.startYear,
      endYear: item.current ? null : item.endYear,
      isCurrent: item.current,
      displayOrder: index,
    })),
  };
}

export function positionLabelKey(position: string | null): "goalkeeper" | "defender" | "midfielder" | "forward" {
  const normalized = (position ?? "").toLowerCase();
  if (normalized.includes("goal") || normalized === "gk") return "goalkeeper";
  if (normalized.includes("def") || normalized === "cb" || normalized === "lb" || normalized === "rb") return "defender";
  if (normalized.includes("for") || normalized.includes("attack") || normalized === "st") return "forward";
  return "midfielder";
}