import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetUserPortfolioQueryKey,
  useGetUserPortfolio,
  useUpdateUserClip,
  useUpdateUserPortfolio,
  type PortfolioClip,
  type PortfolioView,
} from "@workspace/api-client-react";
import { useRoute, useLocation } from "wouter";
import {
  ArrowDown,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  Edit3,
  Eye,
  Gauge,
  Globe,
  LockKeyhole,
  Plus,
  Play,
  Radar,
  Sparkles,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";
import {
  SharedClipPlayerButtons,
  SharedClipTimeline,
  SharedClipVideo,
  useClipPlayerFullscreen,
} from "@/components/clip-player/SharedPlaybackControls";
import { ReplayMark } from "@/components/ReplayMark";
import {
  portfolioFromApi,
  portfolioToUpdateInput,
  positionLabelKey,
  type PortfolioHistoryItem,
  type PortfolioState,
} from "./model";

const POSITION_KEYS = ["goalkeeper", "defender", "midfielder", "forward"] as const;
const CHAPTER_ACCENTS = ["lime", "teal", "violet", "lime", "teal"] as const;

type PortfolioEditorField = "name" | "age" | "nation" | "position" | "profilePhoto";
type PortfolioHistoryEditorField = "academy" | "role" | "startYear" | "endYear" | "isCurrent";
type PortfolioValidationMessageKey =
  | "nameRequired"
  | "nameTooLong"
  | "ageInvalid"
  | "nationTooLong"
  | "positionTooLong"
  | "teamNameRequired"
  | "teamNameTooLong"
  | "roleRequired"
  | "roleTooLong"
  | "startYearInvalid"
  | "endYearInvalid"
  | "endBeforeStart"
  | "currentEndYearInvalid"
  | "multipleCurrent"
  | "historyTooMany"
  | "imageTooLarge"
  | "imageUploadInvalid";
type PortfolioEditorErrors = Partial<Record<PortfolioEditorField, PortfolioValidationMessageKey>> & {
  history: Record<string, Partial<Record<PortfolioHistoryEditorField, PortfolioValidationMessageKey>>>;
  historyLimit?: PortfolioValidationMessageKey;
};

function validatePortfolioEditor(value: PortfolioState): PortfolioEditorErrors {
  const errors: PortfolioEditorErrors = { history: {} };
  if (value.name.trim().length === 0) errors.name = "nameRequired";
  else if (value.name.trim().length > 120) errors.name = "nameTooLong";
  if (value.age !== null && (!Number.isFinite(value.age) || value.age < 5 || value.age > 100)) {
    errors.age = "ageInvalid";
  }
  if (value.nation.trim().length > 80) errors.nation = "nationTooLong";
  if (value.position.trim().length > 64) errors.position = "positionTooLong";
  if (value.history.length > 20) errors.historyLimit = "historyTooMany";

  const addHistoryError = (
    item: PortfolioHistoryItem,
    field: PortfolioHistoryEditorField,
    message: PortfolioValidationMessageKey,
  ) => {
    errors.history[item.editorId] = { ...errors.history[item.editorId], [field]: message };
  };

  for (const item of value.history) {
    if (item.academy.trim().length === 0) addHistoryError(item, "academy", "teamNameRequired");
    else if (item.academy.trim().length > 120) addHistoryError(item, "academy", "teamNameTooLong");

    if (item.role.trim().length === 0) addHistoryError(item, "role", "roleRequired");
    else if (item.role.trim().length > 80) addHistoryError(item, "role", "roleTooLong");

    if (!Number.isInteger(item.startYear) || item.startYear < 1900 || item.startYear > 2100) {
      addHistoryError(item, "startYear", "startYearInvalid");
    }
    if (item.endYear !== null && (!Number.isInteger(item.endYear) || item.endYear < 1900 || item.endYear > 2100)) {
      addHistoryError(item, "endYear", "endYearInvalid");
    }
    if (item.current && item.endYear !== null) {
      addHistoryError(item, "endYear", "currentEndYearInvalid");
    } else if (item.endYear !== null && item.startYear > item.endYear) {
      addHistoryError(item, "endYear", "endBeforeStart");
    }
  }

  const currentItems = value.history.filter((item) => item.current);
  for (const item of currentItems.slice(1)) {
    addHistoryError(item, "isCurrent", "multipleCurrent");
  }
  return errors;
}

function hasPortfolioEditorErrors(errors: PortfolioEditorErrors): boolean {
  return Boolean(
    errors.name ||
    errors.age ||
    errors.nation ||
    errors.position ||
    errors.profilePhoto ||
    errors.historyLimit ||
    Object.values(errors.history).some((rowErrors) => Object.keys(rowErrors).length > 0),
  );
}

function readPortfolioApiError(error: unknown): { status?: number; message?: string } {
  if (typeof error !== "object" || error === null) return {};
  const candidate = error as { status?: unknown; data?: unknown };
  const data = typeof candidate.data === "object" && candidate.data !== null
    ? candidate.data as { error?: unknown }
    : null;
  return {
    status: typeof candidate.status === "number" ? candidate.status : undefined,
    message: typeof data?.error === "string" ? data.error : undefined,
  };
}

function portfolioErrorsFromServerMessage(
  message: string,
  value: PortfolioState,
): PortfolioEditorErrors | null {
  const errors = validatePortfolioEditor(value);
  if (hasPortfolioEditorErrors(errors)) return errors;

  const normalized = message.toLowerCase();
  if (normalized.includes("name must be between")) errors.name = "nameTooLong";
  else if (normalized.includes("nation must be")) errors.nation = "nationTooLong";
  else if (normalized.includes("position must be")) errors.position = "positionTooLong";
  else if (normalized.includes("profile photo must be compressed")) errors.profilePhoto = "imageUploadInvalid";
  else if (normalized.includes("profile photo must be 1.5 mib")) errors.profilePhoto = "imageTooLarge";
  else if (normalized.includes("team or academy names")) {
    const matchingItems = value.history.filter((item) => item.academy.trim().length === 0 || item.academy.trim().length > 120);
    for (const item of matchingItems.length > 0 ? matchingItems : value.history.slice(0, 1)) {
      errors.history[item.editorId] = { ...errors.history[item.editorId], academy: "teamNameTooLong" };
    }
  } else if (normalized.includes("role labels")) {
    const matchingItems = value.history.filter((item) => item.role.trim().length === 0 || item.role.trim().length > 80);
    for (const item of matchingItems.length > 0 ? matchingItems : value.history.slice(0, 1)) {
      errors.history[item.editorId] = { ...errors.history[item.editorId], role: "roleTooLong" };
    }
  } else if (normalized.includes("start years")) {
    const matchingItems = value.history.filter((item) => !Number.isInteger(item.startYear) || item.startYear < 1900 || item.startYear > 2100);
    for (const item of matchingItems.length > 0 ? matchingItems : value.history.slice(0, 1)) {
      errors.history[item.editorId] = { ...errors.history[item.editorId], startYear: "startYearInvalid" };
    }
  } else if (normalized.includes("end years") || normalized.includes("cannot have an end year")) {
    const matchingItems = value.history.filter((item) => item.current ? item.endYear !== null : item.endYear !== null && (!Number.isInteger(item.endYear) || item.endYear < 1900 || item.endYear > 2100));
    for (const item of matchingItems.length > 0 ? matchingItems : value.history.slice(0, 1)) {
      errors.history[item.editorId] = { ...errors.history[item.editorId], endYear: item.current ? "currentEndYearInvalid" : "endYearInvalid" };
    }
  } else if (normalized.includes("start years must not be after end years")) {
    const matchingItems = value.history.filter((item) => item.endYear !== null && item.startYear > item.endYear);
    for (const item of matchingItems.length > 0 ? matchingItems : value.history.slice(0, 1)) {
      errors.history[item.editorId] = { ...errors.history[item.editorId], endYear: "endBeforeStart" };
    }
  } else if (normalized.includes("at most one current entry")) {
    const matchingItems = value.history.filter((item) => item.current).slice(1);
    for (const item of matchingItems.length > 0 ? matchingItems : value.history.slice(0, 1)) {
      errors.history[item.editorId] = { ...errors.history[item.editorId], isCurrent: "multipleCurrent" };
    }
  } else {
    return null;
  }
  return hasPortfolioEditorErrors(errors) ? errors : null;
}

function createPortfolioHistoryEditorId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  return `client-${randomId ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function portfolioClipAspectRatio(clip: PortfolioClip): number {
  const [width, height] = clip.aspectRatio.split(":").map(Number);
  return width > 0 && height > 0 ? width / height : 16 / 9;
}

const PORTFOLIO_HEADER_STYLES = `
  .portfolio-app-header {
    position: sticky;
    inset-block-start: calc(12px + env(safe-area-inset-top));
    z-index: 70;
    margin-block-start: calc(12px + env(safe-area-inset-top));
    margin-inline: 12px;
    background: transparent;
  }
  .portfolio-app-header-shell {
    position: relative;
    display: flex;
    min-height: 55px;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 16px;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 20px;
    background: rgba(10,11,13,.82);
    box-shadow: 0 14px 34px rgba(0,0,0,.2);
    backdrop-filter: blur(14px);
  }
  .portfolio-header-progress {
    position: absolute;
    inset: -1px;
    z-index: 1;
    width: calc(100% + 2px);
    height: calc(100% + 2px);
    overflow: visible;
    pointer-events: none;
  }
  .portfolio-header-progress-stroke,
  .portfolio-header-progress-glow {
    fill: none;
    stroke-linecap: round;
    vector-effect: non-scaling-stroke;
    transition: stroke-dashoffset 260ms ease-out, opacity 260ms ease-out;
  }
  .portfolio-header-progress-stroke { stroke-width: 1.5; }
  .portfolio-header-progress-glow { stroke-width: 3; opacity: 0; filter: url(#portfolio-header-glow); }
  .portfolio-header-content {
    position: relative;
    z-index: 2;
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .portfolio-header-brand-placeholder {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: 8px;
    padding: 0;
    border: 0;
    color: var(--portfolio-ink);
    background: transparent;
    font-family: var(--app-font-display);
    font-size: 21px;
    font-weight: 700;
    letter-spacing: -.015em;
    cursor: pointer;
  }
  .portfolio-header-brand-placeholder > span:last-child {
    background: linear-gradient(90deg, #2fd8c4, #7b5cff);
    background-clip: text;
    color: transparent;
  }
  .portfolio-header-brand-placeholder:focus-visible,
  .portfolio-language-toggle:focus-visible,
  .portfolio-chapter-chip:focus-visible {
    outline: 2px solid var(--portfolio-lime);
    outline-offset: 3px;
  }
  .portfolio-header-brand-placeholder .portfolio-logo-mark { width: 34px; height: 31px; }
  .portfolio-language-toggle {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
    min-height: 40px;
    padding: 8px 14px;
    border: 0;
    border-radius: 99px;
    color: var(--portfolio-ink);
    background: rgba(255,255,255,.07);
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  .portfolio-language-toggle svg { width: 16px; height: 16px; }
  .portfolio-language-toggle span { direction: ltr; unicode-bidi: isolate; }
  .portfolio-chapter-chip {
    position: sticky;
    inset-block-start: calc(78px + env(safe-area-inset-top));
    z-index: 60;
    display: inline-flex;
    align-items: baseline;
    gap: 7px;
    margin-block-start: 9px;
    margin-inline-start: 12px;
    padding: 8px 11px;
    border: 1px solid rgba(255,255,255,.09);
    border-radius: 12px;
    color: var(--portfolio-muted);
    background: rgba(10,11,13,.76);
    box-shadow: 0 10px 22px rgba(0,0,0,.2);
    font-family: var(--app-font-mono);
    font-size: 8px;
    letter-spacing: .08em;
    text-transform: uppercase;
    backdrop-filter: blur(12px);
    direction: ltr;
    unicode-bidi: isolate;
  }
  .portfolio-chapter-chip > bdi:first-child { unicode-bidi: isolate; }
  .portfolio-chapter-chip-numbers {
    direction: ltr;
    unicode-bidi: isolate;
    color: var(--portfolio-dim);
  }
  .portfolio-chapter-chip-numbers strong { font-family: Rajdhani, var(--app-font-display); font-size: 18px; line-height: 1; }
  .portfolio-chapter-chip-numbers strong.is-lime { color: var(--portfolio-lime); }
  .portfolio-chapter-chip-numbers strong.is-teal { color: var(--portfolio-teal); }
  .portfolio-chapter-chip-numbers strong.is-violet { color: var(--portfolio-violet); }
  .portfolio-chapter-chip-total {
    color: var(--portfolio-dim);
    font-family: Rajdhani, var(--app-font-display);
    font-size: 12px;
    line-height: 1;
  }
  .portfolio-ltr-numeric { direction: ltr; unicode-bidi: isolate; }
  .portfolio-proper-noun { unicode-bidi: isolate; }
  .portfolio-directional-icon { transition: transform 180ms ease; }
  .portfolio-page[dir="rtl"] .portfolio-directional-icon { transform: scaleX(-1); }
  .portfolio-history-years {
    display: inline-flex;
    align-items: baseline;
    direction: ltr;
    unicode-bidi: isolate;
    gap: 3px;
  }
  .portfolio-history-current { direction: rtl; unicode-bidi: isolate; }
  .portfolio-chapter-number { display: inline-flex; align-items: baseline; gap: 3px; direction: ltr; unicode-bidi: isolate; }
  .portfolio-field input[type="number"] { direction: ltr; unicode-bidi: isolate; text-align: start; }
  .portfolio-clip-play { inset-block-start: 50%; inset-inline-start: 50%; inset-inline-end: auto; transform: translate(-50%, -50%); }
  .portfolio-page[dir="rtl"] .portfolio-clip-play { transform: translate(50%, -50%); }
  .portfolio-page {
    background: transparent;
  }
  .portfolio-display-headline {
    overflow: visible;
  }
  .portfolio-page[dir="rtl"] .portfolio-display-headline {
    font-size: clamp(32px, calc(10vw - 2px), 46px);
    line-height: 1.28;
  }
  @media (max-width: 360px) {
    .portfolio-page[dir="rtl"] .portfolio-display-headline {
      font-size: 31px;
    }
  }
  .portfolio-micro-label {
    display: inline-block;
    color: inherit;
    font-family: "Inter", var(--app-font-mono), sans-serif;
    font-size: 9px;
    font-weight: 500;
    letter-spacing: .12em;
    line-height: 1.2;
    text-transform: uppercase;
  }
  .portfolio-micro-label.is-compact {
    font-size: 8px;
  }
  .portfolio-micro-label.is-card {
    font-size: 11px;
    letter-spacing: .08em;
  }
  .portfolio-micro-label.is-caption {
    display: block;
    max-width: 300px;
    margin: 18px auto 0;
    color: var(--portfolio-dim);
    font-family: var(--app-font-sans);
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0;
    line-height: 1.55;
    text-align: center;
    text-transform: none;
  }
  .portfolio-micro-label.is-ar {
    color: rgba(235, 245, 239, .88);
    font-family: var(--app-font-arabic, "Tajawal", "Cairo", sans-serif);
    font-size: 12px;
    letter-spacing: 0;
    line-height: 1.35;
    text-transform: none;
  }
  .portfolio-micro-label.is-ar.is-card,
  .portfolio-micro-label.is-ar.is-compact,
  .portfolio-micro-label.is-ar.is-caption {
    font-size: 12px;
  }
  .portfolio-micro-label.is-ar.is-caption {
    color: rgba(235, 245, 239, .88);
    font-family: var(--app-font-arabic, "Tajawal", "Cairo", sans-serif);
  }
  .portfolio-eyebrow.portfolio-micro-label {
    color: var(--portfolio-teal);
  }
  .portfolio-hero-identity-item .portfolio-micro-label {
    color: var(--portfolio-dim);
  }
  .portfolio-hero-identity-item .portfolio-micro-label.is-ar {
    color: rgba(235, 245, 239, .88);
  }
  .portfolio-lock-badge .portfolio-micro-label {
    color: inherit;
  }
  .portfolio-history-main .portfolio-micro-label {
    display: block;
    max-width: 100%;
    margin-block-start: 4px;
    overflow: hidden;
    color: var(--portfolio-dim);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .portfolio-history-main .portfolio-micro-label.is-ar,
  .portfolio-radar-labels .portfolio-micro-label.is-ar {
    color: rgba(235, 245, 239, .88);
  }
  .portfolio-radar-labels .portfolio-micro-label {
    position: absolute;
    color: var(--portfolio-dim);
    font-size: 9px;
    letter-spacing: .06em;
  }
  .portfolio-radar-labels .portfolio-micro-label.is-ar {
    font-size: 12px;
    letter-spacing: 0;
  }
  .portfolio-empty-state .portfolio-micro-label {
    max-width: 220px;
    color: var(--portfolio-muted);
    line-height: 1.4;
    text-align: center;
  }
  .portfolio-empty-state .portfolio-micro-label.is-ar {
    color: rgba(235, 245, 239, .88);
  }
  .portfolio-empty-state .portfolio-micro-label.is-caption {
    display: block;
    margin: 0;
    font-size: 10px;
  }
  .portfolio-empty-state .portfolio-micro-label.is-caption.is-ar {
    font-size: 12px;
  }
  .portfolio-story {
    position: relative;
    z-index: 1;
    background: transparent;
  }
  .portfolio-scene-backdrop {
    position: absolute;
    inset: 0;
    z-index: 0;
    overflow: hidden;
    pointer-events: none;
    background:
      radial-gradient(circle at 74% 28%, rgba(47,216,196,.2), transparent 24%),
      radial-gradient(circle at 14% 72%, rgba(123,92,255,.2), transparent 28%),
      linear-gradient(155deg, #0b0f1a 0%, #081014 47%, #07090f 100%);
  }
  .portfolio-scene-backdrop::before {
    position: absolute;
    inset: 0;
    opacity: .22;
    background-image:
      linear-gradient(rgba(211,239,202,.12) 1px, transparent 1px),
      linear-gradient(90deg, rgba(211,239,202,.12) 1px, transparent 1px);
    background-size: 42px 42px;
    mask-image: linear-gradient(180deg, black, transparent 72%);
    content: "";
  }
  .portfolio-scene-backdrop::after {
    display: none;
  }
  .portfolio-scene-orbit {
    position: absolute;
    z-index: 1;
    border: 1px solid rgba(47,216,196,.18);
    border-radius: 50%;
    transform: rotate(-22deg);
  }
  .portfolio-scene-orbit-one {
    width: 310px;
    height: 145px;
    inset-block-start: 20%;
    inset-inline-end: -100px;
    box-shadow: 0 0 45px rgba(47,216,196,.08);
  }
  .portfolio-scene-orbit-two {
    width: 240px;
    height: 110px;
    inset-block-start: 25%;
    inset-inline-end: -55px;
    border-color: rgba(212,255,79,.14);
  }
  .portfolio-hero {
    margin-block-start: calc(-104px - env(safe-area-inset-top));
    padding-block-start: calc(204px + env(safe-area-inset-top));
  }
  .portfolio-hero {
    overflow: hidden;
    background:
      radial-gradient(circle at 76% 24%, rgba(47,216,196,.075), transparent 34%),
      radial-gradient(circle at 18% 70%, rgba(123,92,255,.055), transparent 40%),
      #07090f;
  }
  .portfolio-hero::after {
    display: none;
  }
  .portfolio-hero-grid,
  .portfolio-hero-orbit {
    z-index: 0;
  }
  .portfolio-hero-grid {
    opacity: .84;
    background-image:
      radial-gradient(circle at 76% 22%, rgba(47,216,196,.11), transparent 31%),
      radial-gradient(circle at 20% 72%, rgba(123,92,255,.08), transparent 38%),
      linear-gradient(rgba(239,246,240,.065) 1px, transparent 1px),
      linear-gradient(90deg, rgba(239,246,240,.065) 1px, transparent 1px);
    background-size: auto, auto, 42px 42px, 42px 42px;
    mask-image: none;
    -webkit-mask-image: none;
    animation: portfolio-hero-grid-breathe 11s ease-in-out infinite;
    will-change: opacity;
  }
  .portfolio-hero-orbit {
    opacity: 1;
    animation: portfolio-hero-orbit-drift 15s ease-in-out infinite;
    will-change: transform;
  }
  .portfolio-hero .portfolio-orbit-one {
    border-color: rgba(47,216,196,.16);
    box-shadow: 0 0 45px rgba(47,216,196,.07);
  }
  .portfolio-hero .portfolio-orbit-two {
    border-color: rgba(123,92,255,.13);
    animation-delay: -7.5s;
  }
  @keyframes portfolio-hero-grid-breathe {
    0%, 100% { opacity: .76; }
    50% { opacity: .92; }
  }
  @keyframes portfolio-hero-orbit-drift {
    0%, 100% { transform: translate3d(0, 0, 0) rotate(-22deg); }
    50% { transform: translate3d(-4px, 3px, 0) rotate(-20.5deg); }
  }
  .portfolio-hero-visual {
    inset-block-start: auto;
    inset-block-end: 14%;
    inset-inline: 0;
    z-index: 2;
    width: 100%;
    height: 70%;
    overflow: hidden;
    border: 0;
    background: transparent;
    box-shadow: none;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }
  .portfolio-hero-visual.has-uploaded-image {
    background: transparent;
  }
  .portfolio-hero-visual::before {
    display: none;
  }
  .portfolio-hero-visual.has-uploaded-image::before {
    display: none;
  }
  .portfolio-hero-visual::after {
    display: none;
  }
  .portfolio-hero-uploaded-image {
    display: block;
    position: relative;
    width: 100%;
    height: 100%;
    object-fit: contain;
    opacity: .98;
    object-position: center top;
    background: transparent;
    transform: translateY(-5%);
  }
  .portfolio-athlete-silhouette {
    inset: 5% 0 0;
    opacity: .8;
    transform: scale(1.55);
    transform-origin: center top;
  }
  .portfolio-outline-name {
    inset-block-start: 16%;
    inset-inline: 0;
    z-index: 1;
    width: 100%;
    max-width: none;
    overflow: visible;
    text-align: center;
    opacity: .9;
  }
  .portfolio-hero-tint {
    position: absolute;
    inset: 0;
    z-index: 3;
    pointer-events: none;
    background: linear-gradient(180deg, transparent 27%, rgba(7,9,15,.04) 39%, rgba(7,9,15,.66) 69%, #07090f 91%);
  }
  .portfolio-hero-copy {
    z-index: 4;
    padding-block-end: 14px;
  }
  .portfolio-page[dir="rtl"] .portfolio-hero-copy {
    text-align: right;
  }
  .portfolio-page[dir="ltr"] .portfolio-hero-copy {
    text-align: left;
  }
  .portfolio-hero-copy h1 > bdi {
    text-align: inherit;
  }
  .portfolio-hero-copy .portfolio-first-name {
    font-size: 20px;
  }
  .portfolio-hero-copy h1 {
    font-size: clamp(57px, 17vw, 86px);
  }
  @media (max-width: 699px) {
    .portfolio-hero {
      display: grid;
      grid-template-rows: 72px 270px auto auto auto;
      row-gap: 22px;
      align-content: start;
      justify-content: stretch;
      min-height: 100%;
      padding-block-start: calc(122px + env(safe-area-inset-top));
      padding-block-end: calc(34px + env(safe-area-inset-bottom));
    }
    .portfolio-outline-name {
      position: relative;
      inset: auto;
      z-index: 1;
      display: block;
      grid-column: 1;
      grid-row: 1;
      align-self: center;
      justify-self: stretch;
      max-width: 100%;
      text-align: center;
    }
    .portfolio-outline-name.portfolio-long-surname {
      font-size: 34px !important;
    }
    .portfolio-hero-visual {
      position: relative;
      inset: auto;
      z-index: 2;
      grid-column: 1;
      grid-row: 2;
      width: 100%;
      height: 100%;
      overflow: hidden;
      align-items: center;
    }
    .portfolio-hero-uploaded-image {
      width: 100%;
      height: 100%;
      object-position: center top;
      transform: none;
    }
    .portfolio-hero-copy {
      grid-column: 1;
      grid-row: 3;
      align-self: start;
      padding-block-end: 0;
      margin-block-start: 0;
    }
    .portfolio-hero-copy h1 > bdi {
      display: block;
      max-width: 100%;
      overflow-wrap: anywhere;
    }
    .portfolio-hero-copy h1.portfolio-long-surname {
      font-size: 38px !important;
      line-height: .95;
    }
    .portfolio-lower-third.portfolio-hero-identity-row {
      grid-column: 1;
      grid-row: 4;
      align-self: start;
    }
    .portfolio-scroll-cue {
      position: relative;
      inset: auto;
      grid-column: 1;
      grid-row: 5;
      align-self: start;
      margin-block-start: 0;
    }
  }
  @media (min-width: 700px) {
    .portfolio-hero-visual {
      height: 65%;
    }
  }
  .portfolio-lower-third.portfolio-hero-identity-row {
    position: relative;
    z-index: 4;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    align-items: stretch;
    gap: 0;
    padding-block-start: 14px;
    border-block-start: 0;
  }
  .portfolio-hero-identity-item {
    display: grid;
    min-width: 0;
    grid-template-rows: auto auto;
    align-items: start;
    gap: 6px;
    padding-inline: 12px;
    border-inline-start: 1px solid rgba(220,232,219,.2);
    unicode-bidi: isolate;
  }
  .portfolio-hero-identity-item > .portfolio-micro-label,
  .portfolio-hero-identity-item > strong {
    width: 100%;
    min-width: 0;
  }
  .portfolio-hero-identity-item:first-child {
    padding-inline-start: 0;
    border-inline-start: 0;
  }
  .portfolio-hero-identity-item:last-child {
    padding-inline-end: 0;
  }
  .portfolio-hero-identity-item small {
    color: var(--portfolio-dim);
    font-family: var(--app-font-mono);
    font-size: 7px;
    letter-spacing: .14em;
    text-transform: uppercase;
  }
  .portfolio-hero-identity-item strong {
    overflow: hidden;
    color: var(--portfolio-ink);
    font-family: Rajdhani, var(--app-font-display);
    font-size: 20px;
    line-height: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .portfolio-hero-identity-item:first-child strong {
    font-size: 24px;
  }
  .portfolio-hero-identity-item:last-child strong {
    font-family: var(--app-font-display);
    font-size: 15px;
  }
  .portfolio-scroll-cue {
    z-index: 4;
  }
  .portfolio-content-chapter {
    padding-block-start: calc(132px + env(safe-area-inset-top));
    padding-block-end: calc(170px + env(safe-area-inset-bottom));
    scroll-margin-block-start: calc(132px + env(safe-area-inset-top));
  }
  .portfolio-locked-visual-content {
    opacity: .55;
  }
  .portfolio-lock-overlay {
    background: rgba(3,7,13,.42);
  }
  .portfolio-closing-section {
    display: flex;
    min-height: 100%;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 132px 24px calc(190px + env(safe-area-inset-bottom));
    background: #07090f;
    text-align: center;
  }
  .portfolio-closing-section::before {
    width: min(100%, 320px);
    height: 1px;
    margin-block-end: 28px;
    background: linear-gradient(90deg, transparent, rgba(47,216,196,.42), rgba(212,255,79,.42), transparent);
    content: "";
  }
  .portfolio-closing-section .portfolio-eyebrow {
    margin-block-end: 13px;
    color: var(--portfolio-teal);
  }
  .portfolio-closing-section h2 {
    max-width: 320px;
    margin: 0;
    font-family: var(--app-font-display);
    font-size: clamp(34px, 10vw, 48px);
    letter-spacing: -.06em;
    line-height: .92;
  }
  .portfolio-closing-copy {
    max-width: 260px;
    margin: 18px 0 26px;
    color: var(--portfolio-muted);
    font-size: 11px;
    line-height: 1.5;
  }
  .portfolio-share-button {
    display: inline-flex;
    min-height: 45px;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 19px;
    border: 0;
    color: #08100e;
    background: linear-gradient(105deg, var(--portfolio-lime), var(--portfolio-teal));
    font-family: var(--app-font-mono);
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    cursor: pointer;
  }
  .portfolio-share-button svg { width: 15px; height: 15px; }
  .portfolio-share-status {
    min-height: 15px;
    margin-block-start: 9px;
    color: var(--portfolio-lime);
    font-family: var(--app-font-mono);
    font-size: 8px;
  }
  .portfolio-closing-edit {
    margin-block-start: 18px;
    padding: 0;
    border: 0;
    color: var(--portfolio-muted);
    background: transparent;
    font-family: var(--app-font-mono);
    font-size: 8px;
    text-decoration: underline;
    text-underline-offset: 4px;
    cursor: pointer;
  }
  .portfolio-share-button:focus-visible,
  .portfolio-closing-edit:focus-visible {
    outline: 2px solid var(--portfolio-lime);
    outline-offset: 4px;
  }
  @media (min-width: 768px) {
    .portfolio-app-header-shell,
    .portfolio-chapter-chip {
      backdrop-filter: none;
    }
    .portfolio-hero-grid {
      animation: none;
      will-change: auto;
    }
    .portfolio-hero-orbit {
      animation: none;
      will-change: auto;
    }
    .portfolio-hero .portfolio-orbit-one {
      box-shadow: none;
    }
    .portfolio-athlete-silhouette {
      filter: none;
    }
    .portfolio-locked-visual-content {
      filter: blur(2px);
    }
    .portfolio-ring-glow {
      filter: blur(8px);
    }
    .portfolio-stats-ring::before,
    .portfolio-stats-ring::after {
      animation: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .portfolio-header-progress-stroke,
    .portfolio-header-progress-glow,
    .portfolio-directional-icon { transition: none; }
    .portfolio-hero-grid,
    .portfolio-hero-orbit { animation: none; }
  }
`;

function usePortfolioSurnameSizing(surname: string, locale: "en" | "ar") {
  const headlineRef = useRef<HTMLHeadingElement>(null);
  const watermarkRef = useRef<HTMLSpanElement>(null);
  const [sizes, setSizes] = useState<{ headline: number | null; watermark: number | null }>({
    headline: null,
    watermark: null,
  });

  useEffect(() => {
    const headline = headlineRef.current;
    const watermark = watermarkRef.current;
    if (!headline || !watermark) return;

    const findLargestFittingSize = (
      element: HTMLElement,
      maxSize: number,
      minSize: number,
      fits: () => boolean,
    ) => {
      const previousSize = element.style.fontSize;
      const previousWhiteSpace = element.style.whiteSpace;
      let low = minSize;
      let high = maxSize;

      element.style.whiteSpace = "nowrap";
      for (let index = 0; index < 12; index += 1) {
        const candidate = (low + high) / 2;
        element.style.fontSize = `${candidate}px`;
        if (fits()) low = candidate;
        else high = candidate;
      }

      element.style.fontSize = previousSize;
      element.style.whiteSpace = previousWhiteSpace;
      return low;
    };

    const renderedTextFits = (element: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const renderedWidth = range.getBoundingClientRect().width;
      range.detach();
      return renderedWidth <= element.clientWidth + 1;
    };

    const measure = () => {
      const headlineSize = findLargestFittingSize(headline, 90, 30, () => {
        const lineHeight = Number.parseFloat(window.getComputedStyle(headline).lineHeight);
        return renderedTextFits(headline) && headline.scrollHeight <= lineHeight * 2 + 3;
      });
      const watermarkSize = findLargestFittingSize(watermark, 112, 30, () => {
        return renderedTextFits(watermark);
      });

      setSizes({ headline: headlineSize, watermark: watermarkSize });
    };

    const frame = requestAnimationFrame(measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(headline.parentElement ?? headline);
    observer?.observe(watermark);

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [locale, surname]);

  return {
    headlineRef,
    watermarkRef,
    headlineStyle: sizes.headline ? { fontSize: `${sizes.headline}px` } : undefined,
    watermarkStyle: sizes.watermark ? { fontSize: `${sizes.watermark}px` } : undefined,
  };
}

export default function PortfolioPage() {
  const [, params] = useRoute("/portfolio/:id");
  const [, setLocation] = useLocation();
  const { t, locale, setLocale } = useTranslation();
  const playerId = Number.parseInt(params?.id ?? "", 10);
  const validId = Number.isFinite(playerId) && playerId > 0;
  const [editorOpen, setEditorOpen] = useState(false);
  const [activeChapter, setActiveChapter] = useState(0);
  const activeChapterRef = useRef(0);
  const progressStrokeRef = useRef<SVGRectElement>(null);
  const progressGlowRef = useRef<SVGRectElement>(null);
  const storyRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const portfolioPollRef = useRef({ dataUpdatedAt: 0, intervalMs: 3_000 });

  const portfolioQuery = useGetUserPortfolio(playerId, {
    query: {
      enabled: validId,
      queryKey: getGetUserPortfolioQueryKey(playerId),
      retry: false,
      refetchInterval: (query) => {
        const hasProcessingClip = query.state.data?.clips.some(
          (clip) => clip.playbackStatus === "processing",
        ) ?? false;
        if (!hasProcessingClip) {
          portfolioPollRef.current = { dataUpdatedAt: 0, intervalMs: 3_000 };
          return false;
        }

        const updatedAt = query.state.dataUpdatedAt;
        if (updatedAt > 0 && updatedAt !== portfolioPollRef.current.dataUpdatedAt) {
          if (portfolioPollRef.current.dataUpdatedAt > 0) {
            portfolioPollRef.current.intervalMs = Math.min(
              portfolioPollRef.current.intervalMs * 2,
              30_000,
            );
          }
          portfolioPollRef.current.dataUpdatedAt = updatedAt;
        }
        return portfolioPollRef.current.intervalMs;
      },
    },
  });
  const updatePortfolio = useUpdateUserPortfolio();

  useEffect(() => {
    const node = storyRef.current;
    if (!node) return;
    let frame = 0;
    const chapterNodes = Array.from(node.querySelectorAll<HTMLElement>("[data-portfolio-chapter]"));
    const updateProgress = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const max = node.scrollHeight - node.clientHeight;
        const value = max > 0 ? node.scrollTop / max : 0;
        const strokeOffset = String(1 - Math.max(0, Math.min(1, value)));
        progressStrokeRef.current?.setAttribute("stroke-dashoffset", strokeOffset);
        progressGlowRef.current?.setAttribute("stroke-dashoffset", strokeOffset);
        if (progressGlowRef.current) {
          progressGlowRef.current.style.opacity = value > 0 ? "0.85" : "0";
        }
        let current = 0;
        chapterNodes.forEach((chapter, index) => {
          if (chapter.offsetTop - node.scrollTop < node.clientHeight * 0.48) current = index;
        });
        if (current !== activeChapterRef.current) {
          activeChapterRef.current = current;
          setActiveChapter(current);
        }
      });
    };
    updateProgress();
    node.addEventListener("scroll", updateProgress, { passive: true });
    return () => {
      node.removeEventListener("scroll", updateProgress);
      cancelAnimationFrame(frame);
    };
  }, [playerId, portfolioQuery.data, portfolioQuery.isError, portfolioQuery.isLoading]);

  const model = useMemo(
    () => portfolioQuery.data ? portfolioFromApi(portfolioQuery.data) : null,
    [portfolioQuery.data],
  );
  const firstName = model?.name.trim().split(/\s+/)[0] || "";
  const surname = model?.name.trim().split(/\s+/).slice(1).join(" ") || firstName;
  const isLongSurname = surname.length > 9;
  const positionKey = positionLabelKey(model?.position ?? "");
  const {
    headlineRef,
    watermarkRef,
    headlineStyle,
    watermarkStyle,
  } = usePortfolioSurnameSizing(surname, locale);

  if (!validId) {
    return <PortfolioStateScreen title={t.portfolio.notFound} description={t.portfolio.invalidPlayer} onBack={() => setLocation("/")} />;
  }

  if (portfolioQuery.isLoading) {
    return <PortfolioStateScreen title={t.portfolio.loading} description={t.portfolio.loadingDesc} />;
  }

  if (portfolioQuery.isError || !model) {
    return <PortfolioStateScreen title={t.portfolio.notFound} description={t.portfolio.notFoundDesc} onBack={() => setLocation("/")} />;
  }

  return (
    <div className="portfolio-page" dir={locale === "ar" ? "rtl" : "ltr"}>
      <style>{PORTFOLIO_HEADER_STYLES}</style>
      <div className="portfolio-scene-backdrop" aria-hidden="true">
        <span className="portfolio-scene-orbit portfolio-scene-orbit-one" />
        <span className="portfolio-scene-orbit portfolio-scene-orbit-two" />
      </div>
      <div ref={storyRef} className="portfolio-story">
          <PortfolioHeader
            progressStrokeRef={progressStrokeRef}
            progressGlowRef={progressGlowRef}
            locale={locale}
            onLocaleChange={() => setLocale(locale === "ar" ? "en" : "ar")}
          />
        <PortfolioChapterChip activeChapter={activeChapter} />
        <section data-portfolio-chapter className="portfolio-hero portfolio-chapter">
          <div className="portfolio-hero-orbit portfolio-orbit-one" />
          <div className="portfolio-hero-orbit portfolio-orbit-two" />
          <div className="portfolio-hero-grid" />
          <span ref={watermarkRef} className={cn("portfolio-outline-name", isLongSurname && "portfolio-long-surname")} style={watermarkStyle} aria-hidden="true">{surname}</span>
          <div className={cn("portfolio-hero-visual", model.profilePhoto && "has-uploaded-image")} aria-label={model.profilePhoto ? model.name : t.portfolio.imageFallback}>
            {model.profilePhoto ? (
              <img className="portfolio-hero-uploaded-image" src={model.profilePhoto} alt={model.name} />
            ) : (
              <div className="portfolio-athlete-silhouette" aria-hidden="true">
                <span className="portfolio-athlete-head" />
                <span className="portfolio-athlete-body" />
                <span className="portfolio-athlete-ball" />
              </div>
            )}
          </div>
          <div className="portfolio-hero-tint" aria-hidden="true" />
          <div className="portfolio-hero-copy">
            <span className="portfolio-first-name portfolio-proper-noun"><bdi dir="auto">{firstName}</bdi></span>
            <h1 ref={headlineRef} className={cn("portfolio-proper-noun", isLongSurname && "portfolio-long-surname")} style={headlineStyle}><bdi dir="auto">{surname}</bdi></h1>
          </div>
          <div className="portfolio-lower-third portfolio-hero-identity-row">
            <div className="portfolio-hero-identity-item">
               <PortfolioMicroLabel>{t.portfolio.age}</PortfolioMicroLabel>
              <strong><bdi className="portfolio-ltr-numeric" dir="ltr">{model.age ?? "—"}</bdi></strong>
            </div>
            <div className="portfolio-hero-identity-item">
               <PortfolioMicroLabel>{t.portfolio.nation}</PortfolioMicroLabel>
              <strong className="portfolio-proper-noun"><bdi dir="auto">{model.nation || "—"}</bdi></strong>
            </div>
            <div className="portfolio-hero-identity-item">
               <PortfolioMicroLabel>{t.portfolio.position}</PortfolioMicroLabel>
              <strong><bdi dir="auto">{t.onboarding.positions[positionKey]}</bdi></strong>
            </div>
          </div>
          <div className="portfolio-scroll-cue">
             <PortfolioMicroLabel>{t.portfolio.scrollToExplore}</PortfolioMicroLabel>
            <ArrowDown className="animate-bounce" />
          </div>
        </section>

        <StoryChapter label={t.portfolio.historyLabel} title={t.portfolio.historyTitle} accent="teal">
          <div className="portfolio-history-intro">
            <p>{t.portfolio.historyDesc}</p>
          </div>
          {model.history.length > 0 ? (
            <div className="portfolio-history-list">
              {model.history.map((item, index) => (
                <HistoryRow key={item.editorId} item={item} index={index} />
              ))}
            </div>
          ) : (
            <div className="portfolio-history-empty" role="status">
              <PortfolioMicroLabel className="is-caption">{t.portfolio.historyEmpty}</PortfolioMicroLabel>
            </div>
          )}
          <div className="portfolio-history-footer">
             <PortfolioMicroLabel className="is-compact">{t.portfolio.verifiedPath}</PortfolioMicroLabel>
          </div>
        </StoryChapter>

        <StoryChapter label={t.portfolio.vaultLabel} title={t.portfolio.vaultTitle} accent="lime">
          <p className="portfolio-section-desc">{t.portfolio.vaultDesc}</p>
          <VideoVault
            clips={model.clips}
            isLoading={false}
            isError={false}
          />
        </StoryChapter>

        <StoryChapter label={t.portfolio.statsLabel} title={t.portfolio.statsTitle} accent="violet" locked>
          <LockedStats />
        </StoryChapter>

        <StoryChapter label={t.portfolio.analysisLabel} title={t.portfolio.analysisTitle} accent="teal" locked>
          <LockedAnalysis />
          <div className="portfolio-end-card">
            <Sparkles />
            <p>{t.portfolio.endNote}</p>
          </div>
        </StoryChapter>
        <PortfolioClosing onEdit={model.canEdit ? () => setEditorOpen(true) : undefined} />
      </div>

      {model.canEdit && (
        <div className="portfolio-fixed-actions">
          <PortfolioFixedShare />
          <div className="portfolio-fixed-action-row">
            <button type="button" className="portfolio-edit-button" onClick={() => setEditorOpen(true)}>
              <Edit3 />
               <PortfolioMicroLabel className="is-compact">{t.portfolio.editStory}</PortfolioMicroLabel>
            </button>
          </div>
        </div>
      )}

      <AnimatePresence>
        {editorOpen && (
            <PortfolioEditor
            value={model}
             clips={model.clips}
            onClose={() => setEditorOpen(false)}
             onClipRemoved={(clipId) => {
               queryClient.setQueryData<PortfolioView | undefined>(
                 getGetUserPortfolioQueryKey(playerId),
                 (current) => current ? { ...current, clips: current.clips.filter((clip) => clip.id !== clipId) } : current,
               );
               void queryClient.invalidateQueries({ queryKey: getGetUserPortfolioQueryKey(playerId) });
             }}
            onSave={async (next) => {
              const saved = await updatePortfolio.mutateAsync({
                id: playerId,
                data: portfolioToUpdateInput(next),
              });
              queryClient.setQueryData(getGetUserPortfolioQueryKey(playerId), saved);
              setEditorOpen(false);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function PortfolioMicroLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  const { locale } = useTranslation();
  return <span className={cn("portfolio-micro-label", locale === "ar" && "is-ar", className)}>{children}</span>;
}

function PortfolioClosing({ onEdit }: { onEdit?: () => void }) {
  const { t } = useTranslation();
  const { copyState, copyStoryLink } = useStoryLinkCopy();

  return (
    <section className="portfolio-closing-section">
       <PortfolioMicroLabel className="portfolio-eyebrow">{t.portfolio.closingLabel}</PortfolioMicroLabel>
      <h2 className="portfolio-display-headline">{t.portfolio.verifiedOnFilm}</h2>
      <p className="portfolio-closing-copy">{t.portfolio.closingDesc}</p>
       <PortfolioShareButton copyState={copyState} onCopy={copyStoryLink} />
       <span className="portfolio-share-status" role="status" aria-live="polite">
         <PortfolioMicroLabel className="is-compact">
           {copyState === "failed" ? t.portfolio.storyCopyFailed : copyState === "copied" ? t.portfolio.storyCopied : ""}
         </PortfolioMicroLabel>
       </span>
       {onEdit && <button type="button" className="portfolio-closing-edit" onClick={onEdit}><PortfolioMicroLabel className="is-compact">{t.portfolio.editYourStory}</PortfolioMicroLabel></button>}
    </section>
  );
}

function useStoryLinkCopy() {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const copyStoryLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return { copyState, copyStoryLink };
}

function PortfolioShareButton({
  copyState,
  onCopy,
  className,
}: {
  copyState: "idle" | "copied" | "failed";
  onCopy: () => Promise<void>;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <button type="button" className={cn("portfolio-share-button", className)} onClick={onCopy}>
      <Share2 />
      <PortfolioMicroLabel className="is-compact">{copyState === "copied" ? t.portfolio.storyCopied : t.portfolio.shareStory}</PortfolioMicroLabel>
    </button>
  );
}

function PortfolioFixedShare() {
  const { t } = useTranslation();
  const { copyState, copyStoryLink } = useStoryLinkCopy();
  return (
    <div className="portfolio-fixed-share">
      <PortfolioShareButton className="portfolio-fixed-share-button" copyState={copyState} onCopy={copyStoryLink} />
      <span className="portfolio-share-status" role="status" aria-live="polite">
        <PortfolioMicroLabel className="is-compact">
          {copyState === "failed" ? t.portfolio.storyCopyFailed : copyState === "copied" ? t.portfolio.storyCopied : ""}
        </PortfolioMicroLabel>
      </span>
    </div>
  );
}

function PortfolioStateScreen({ title, description, onBack }: { title: string; description: string; onBack?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="portfolio-state-screen">
      <PortfolioLogoMark />
      <h1>{title}</h1>
      <p>{description}</p>
       {onBack && <button type="button" className="portfolio-text-button" onClick={onBack}><ArrowLeft className="portfolio-directional-icon" /> <PortfolioMicroLabel className="is-compact">{t.portfolio.returnToReplay}</PortfolioMicroLabel></button>}
    </div>
  );
}

function PortfolioHeader({
  progressStrokeRef,
  progressGlowRef,
  locale,
  onLocaleChange,
}: {
  progressStrokeRef: RefObject<SVGRectElement | null>;
  progressGlowRef: RefObject<SVGRectElement | null>;
  locale: "en" | "ar";
  onLocaleChange: () => void;
}) {
  const { t } = useTranslation();
  const headerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = headerRef.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [locale]);

  const width = Math.max(size.width, 1);
  const height = Math.max(size.height, 1);
  const radius = Math.min(20, height / 2);

  return (
    <header className="portfolio-app-header">
      <div ref={headerRef} className="portfolio-app-header-shell">
        {size.width > 0 && (
          <svg className="portfolio-header-progress" viewBox={`0 0 ${width} ${height}`} aria-hidden="true" preserveAspectRatio="none">
            <defs>
              <linearGradient id="portfolio-header-progress-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#d4ff4f" />
                <stop offset="52%" stopColor="#2fd8c4" />
                <stop offset="100%" stopColor="#7b5cff" />
              </linearGradient>
              <filter id="portfolio-header-glow" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="2.5" />
              </filter>
            </defs>
            <rect
                ref={progressGlowRef}
              className="portfolio-header-progress-glow"
              x=".75"
              y=".75"
              width={Math.max(1, width - 1.5)}
              height={Math.max(1, height - 1.5)}
              rx={radius}
              pathLength="1"
              stroke="url(#portfolio-header-progress-gradient)"
              strokeDasharray="1"
                strokeDashoffset="1"
                style={{ opacity: 0 }}
            />
            <rect
                ref={progressStrokeRef}
              className="portfolio-header-progress-stroke"
              x=".75"
              y=".75"
              width={Math.max(1, width - 1.5)}
              height={Math.max(1, height - 1.5)}
              rx={radius}
              pathLength="1"
              stroke="url(#portfolio-header-progress-gradient)"
              strokeDasharray="1"
                strokeDashoffset="1"
            />
          </svg>
        )}
        <div className="portfolio-header-content">
          {/* This placeholder will later route to the signed-in user's account or the Replay home page. */}
          <button
            type="button"
            className="portfolio-header-brand-placeholder"
            onClick={(event) => event.preventDefault()}
            aria-label={t.portfolio.replayHomePlaceholder}
          >
            <PortfolioLogoMark />
            <span>REPLAY</span>
          </button>
          <button type="button" className="portfolio-language-toggle" onClick={onLocaleChange} aria-label={t.portfolio.changeLanguage}>
            <Globe aria-hidden="true" />
            <span>{locale.toUpperCase()}</span>
          </button>
        </div>
      </div>
    </header>
  );
}

function PortfolioChapterChip({ activeChapter }: { activeChapter: number }) {
  const { t, locale } = useTranslation();
  const accent = CHAPTER_ACCENTS[activeChapter] ?? "lime";
  return (
    <div className="portfolio-chapter-chip" aria-live="polite">
       <bdi dir={locale === "ar" ? "rtl" : "ltr"}><PortfolioMicroLabel>{t.portfolio.chapter}</PortfolioMicroLabel></bdi>
      <bdi dir="ltr" className="portfolio-chapter-chip-numbers">
        <strong className={`is-${accent}`}>{String(activeChapter + 1).padStart(2, "0")}</strong>
        <span aria-hidden="true"> / </span>
        <span className="portfolio-chapter-chip-total">05</span>
      </bdi>
    </div>
  );
}

function PortfolioLogoMark() {
  const facets = [
    { cx: 95, cy: 96, color: "#22C7B5" },
    { cx: 126.2, cy: 42, color: "#BFFF5C" },
    { cx: 63.8, cy: 42, color: "#3FE0C9" },
    { cx: 157.4, cy: 96, color: "#1FA79B" },
    { cx: 32.6, cy: 96, color: "#186E7E" },
    { cx: 126.2, cy: 150, color: "#1C8AA0" },
    { cx: 63.8, cy: 150, color: "#6C4FE0" },
  ];
  return (
    <span className="portfolio-logo-mark">
      <svg viewBox="-5 0 225 200" width="100%" height="100%" aria-hidden="true">
        <defs><clipPath id="portfolio-logo-ball-clip"><circle cx="95" cy="96" r="88" /></clipPath></defs>
        <g clipPath="url(#portfolio-logo-ball-clip)">
          {facets.map((facet) => <polygon key={`${facet.cx}-${facet.cy}`} points={hexPoints(facet.cx, facet.cy, 36)} fill={facet.color} stroke="#0B0F1A" strokeWidth="1.5" strokeLinejoin="round" />)}
        </g>
        <circle cx="95" cy="96" r="88" fill="none" stroke="#0B0F1A" strokeWidth="3" opacity="0.35" />
        <polygon points="170,62 170,134 210,98" fill="#0B0F1A" stroke="#0B0F1A" strokeWidth="16" strokeLinejoin="round" />
        <polygon points="172,68 172,128 206,98" fill="#D4FF4F" stroke="#D4FF4F" strokeWidth="12" strokeLinejoin="round" />
        <circle cx="178" cy="46" r="7.5" fill="#0B0F1A" />
        <circle cx="178" cy="46" r="5.5" fill="#FF5A3C" />
      </svg>
    </span>
  );
}

function hexPoints(cx: number, cy: number, size: number) {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 180) * (60 * index - 90);
    return `${(cx + size * Math.cos(angle)).toFixed(1)},${(cy + size * Math.sin(angle)).toFixed(1)}`;
  }).join(" ");
}

function usePortfolioDesktopMotion() {
  const [isDesktop, setIsDesktop] = useState(() => (
    typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches
  ));

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return isDesktop;
}

function StoryChapter({
  label,
  title,
  accent,
  locked = false,
  children,
}: {
  label: string;
  title: string;
  accent: "lime" | "teal" | "violet";
  locked?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const desktopMotion = usePortfolioDesktopMotion();
  return (
    <motion.section
      data-portfolio-chapter
      className="portfolio-chapter portfolio-content-chapter"
      initial={desktopMotion ? false : { opacity: 0, y: 34 }}
      whileInView={desktopMotion ? undefined : { opacity: 1, y: 0 }}
      viewport={desktopMotion ? undefined : { once: true, amount: 0.18 }}
      transition={desktopMotion ? undefined : { duration: 0.65, ease: "easeOut" }}
    >
      <div className="portfolio-section-heading">
        <div>
          <span className={cn("portfolio-chapter-dot", `is-${accent}`)} />
           <PortfolioMicroLabel className="portfolio-eyebrow">{label}</PortfolioMicroLabel>
        </div>
      </div>
      <div className="portfolio-title-row">
        <h2 className="portfolio-display-headline">{title}</h2>
        {locked && <LockKeyhole className="portfolio-lock" />}
      </div>
      {children}
    </motion.section>
  );
}

function HistoryRow({ item, index }: { item: PortfolioHistoryItem; index: number }) {
  const { t } = useTranslation();
  const desktopMotion = usePortfolioDesktopMotion();
  const role = item.role === "firstTeam" || item.role === "developmentSquad" || item.role === "academyPlayer"
    ? t.portfolio.roles[item.role]
    : item.role;
  return (
    <motion.div
      className="portfolio-history-row"
      initial={desktopMotion ? false : { opacity: 0, x: -16 }}
      whileInView={desktopMotion ? undefined : { opacity: 1, x: 0 }}
      viewport={desktopMotion ? undefined : { once: true }}
      transition={desktopMotion ? undefined : { delay: index * 0.1, duration: 0.45 }}
    >
      <bdi dir="ltr" className={cn("portfolio-history-marker", "portfolio-ltr-numeric", `is-${item.accent}`)}>{String(index + 1).padStart(2, "0")}</bdi>
      <div className="portfolio-history-main">
        <strong className="portfolio-proper-noun"><bdi dir="auto">{item.academy}</bdi></strong>
         <PortfolioMicroLabel>{role}</PortfolioMicroLabel>
      </div>
      <bdi dir="ltr" className="portfolio-history-years portfolio-mono">
        <span className="portfolio-ltr-numeric">{item.startYear}</span>
        {(item.current || item.endYear !== null) && (
          <>
            <span aria-hidden="true">—</span>
            <span className={item.current ? "portfolio-history-current" : "portfolio-ltr-numeric"}>
              {item.current ? <PortfolioMicroLabel className="is-compact">{t.portfolio.current}</PortfolioMicroLabel> : item.endYear}
            </span>
          </>
        )}
      </bdi>
    </motion.div>
  );
}

function LockedStats() {
  const { t } = useTranslation();
  return (
    <div className="portfolio-locked-panel">
      <div className="portfolio-locked-visual">
        <div className="portfolio-locked-visual-content" aria-hidden="true">
          <div className="portfolio-stats-ring">
            <div className="portfolio-ring-glow" />
            <Gauge />
            <strong>—</strong>
             <PortfolioMicroLabel className="is-compact">{t.portfolio.liveMetrics}</PortfolioMicroLabel>
          </div>
          <div className="portfolio-metric-list">
            {[
              [t.portfolio.pace, "lime"],
              [t.portfolio.shooting, "teal"],
              [t.portfolio.dribbling, "violet"],
            ].map(([label, accent]) => (
              <div className="portfolio-metric-row" key={label}>
                <span className={cn("portfolio-metric-bullet", `is-${accent}`)} />
                <span>{label}</span>
                <span className="portfolio-mono">--</span>
              </div>
            ))}
          </div>
        </div>
        <div className="portfolio-lock-overlay">
           <div className="portfolio-lock-badge portfolio-lock-badge-large"><LockKeyhole /> <PortfolioMicroLabel className="is-card">{t.portfolio.comingSoon}</PortfolioMicroLabel></div>
        </div>
      </div>
       <PortfolioMicroLabel className="is-caption">{t.portfolio.statsLocked}</PortfolioMicroLabel>
    </div>
  );
}

function LockedAnalysis() {
  const { t } = useTranslation();
  const points = "50,12 80,32 70,72 30,72 20,32";
  return (
    <div className="portfolio-analysis-panel">
      <div className="portfolio-locked-visual">
        <div className="portfolio-locked-visual-content" aria-hidden="true">
          <div className="portfolio-radar-wrap">
            <svg viewBox="0 0 100 100" className="portfolio-radar">
              {[20, 38, 56, 74].map((size) => (
                <polygon key={size} points={`50,${50 - size / 2} ${50 + size * 0.58},${50 - size * 0.16} ${50 + size * 0.38},${50 + size * 0.45} ${50 - size * 0.38},${50 + size * 0.45} ${50 - size * 0.58},${50 - size * 0.16}`} className="portfolio-radar-grid" />
              ))}
              <polygon points={points} className="portfolio-radar-fill" />
              <polygon points={points} className="portfolio-radar-line" />
              {[["50%", "5%"], ["96%", "38%"], ["73%", "92%"], ["27%", "92%"], ["4%", "38%"]].map(([left, top]) => (
                <circle key={`${left}-${top}`} cx={left} cy={top} r="2" className="portfolio-radar-point" />
              ))}
            </svg>
             <div className="portfolio-radar-labels">
               <PortfolioMicroLabel>{t.portfolio.vision}</PortfolioMicroLabel><PortfolioMicroLabel>{t.portfolio.control}</PortfolioMicroLabel><PortfolioMicroLabel>{t.portfolio.power}</PortfolioMicroLabel><PortfolioMicroLabel>{t.portfolio.speed}</PortfolioMicroLabel><PortfolioMicroLabel>{t.portfolio.impact}</PortfolioMicroLabel>
            </div>
          </div>
        </div>
        <div className="portfolio-lock-overlay">
           <div className="portfolio-lock-badge portfolio-lock-badge-large"><LockKeyhole /> <PortfolioMicroLabel className="is-card">{t.portfolio.aiComingSoon}</PortfolioMicroLabel></div>
        </div>
      </div>
       <PortfolioMicroLabel className="is-caption">{t.portfolio.analysisLocked}</PortfolioMicroLabel>
    </div>
  );
}

function PortfolioClipPreview({ clip }: { clip: PortfolioClip }) {
  const { t } = useTranslation();
  if (clip.thumbnailUrl) {
    return (
      <img
        src={clip.thumbnailUrl}
        alt=""
        loading="lazy"
        decoding="async"
        aria-hidden="true"
      />
    );
  }
  return <div className="portfolio-clip-fallback" aria-hidden="true"><span>R</span></div>;
}

function VideoVault({ clips, isLoading, isError }: { clips: PortfolioClip[]; isLoading: boolean; isError: boolean }) {
  const { t } = useTranslation();
  const [activeClipId, setActiveClipId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const desktopMotion = usePortfolioDesktopMotion();
  const activeClip = activeClipId === null
    ? null
    : clips.find((clip) => clip.id === activeClipId) ?? null;

  useEffect(() => {
    if (activeClipId !== null && !clips.some((clip) => clip.id === activeClipId)) {
      setActiveClipId(null);
    }
  }, [activeClipId, clips]);

  if (isLoading) {
    return <div className="portfolio-vault-list">{[1, 2, 3].map((item) => <div key={item} className="portfolio-clip-skeleton" />)}</div>;
  }
  if (isError) {
    return <div className="portfolio-empty-state"><Eye /><strong><PortfolioMicroLabel className="is-card">{t.portfolio.vaultUnavailable}</PortfolioMicroLabel></strong><span>{t.portfolio.vaultUnavailableDesc}</span></div>;
  }
  if (clips.length === 0) {
    return <div className="portfolio-empty-state"><Play /><strong><PortfolioMicroLabel className="is-card">{t.portfolio.noPublicClips}</PortfolioMicroLabel></strong><span>{t.portfolio.noPublicClipsDesc}</span></div>;
  }

  const visibleClips = expanded ? clips : clips.slice(0, 4);
  const hasMore = clips.length > 4;

  return (
    <>
      <div className={cn("portfolio-vault-list", `is-count-${Math.min(clips.length, 5)}`, expanded && "is-expanded")}>
        {visibleClips.map((clip, index) => (
          <motion.button
            type="button"
            key={clip.id}
            className="portfolio-clip-card"
            onClick={() => setActiveClipId(clip.id)}
            initial={desktopMotion ? false : { opacity: 0, y: 16 }}
            whileInView={desktopMotion ? undefined : { opacity: 1, y: 0 }}
            viewport={desktopMotion ? undefined : { once: true }}
            transition={desktopMotion ? undefined : { delay: index * 0.08 }}
          >
            <div className="portfolio-clip-media">
              {clip.playbackUrl
                ? <PortfolioClipPreview clip={clip} />
                : <div className="portfolio-clip-fallback"><span>R</span></div>}
              <div className="portfolio-clip-shade" />
              <span className="portfolio-clip-play"><Play fill="currentColor" /></span>
              <bdi dir="ltr" className="portfolio-clip-index portfolio-mono portfolio-ltr-numeric">{String(index + 1).padStart(2, "0")}</bdi>
            </div>
            <div className="portfolio-clip-copy">
              <strong className="portfolio-proper-noun"><bdi dir="auto">{clip.title}</bdi></strong>
               <PortfolioMicroLabel className="is-compact">{t.portfolio.publicMoment}</PortfolioMicroLabel>
              {!clip.playbackUrl && (
                <PortfolioMicroLabel className="is-compact">
                  {clip.playbackStatus === "expired"
                    ? t.portfolio.clipExpired
                    : clip.playbackStatus === "processing"
                      ? t.portfolio.clipProcessing
                      : t.portfolio.videoUnavailable}
                </PortfolioMicroLabel>
              )}
            </div>
            <ChevronRight className="portfolio-clip-arrow portfolio-directional-icon" />
          </motion.button>
        ))}
      </div>
      {hasMore && (
        <button
          type="button"
          className="portfolio-more-clips"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <PortfolioMicroLabel className="is-compact">
            {expanded ? t.portfolio.showFewerClips : t.portfolio.moreClips(clips.length - 4)}
          </PortfolioMicroLabel>
          <ChevronDown className={cn("portfolio-more-clips-icon", expanded && "is-expanded")} />
        </button>
      )}
      <AnimatePresence>
        {activeClip && <PortfolioClipViewer key={activeClip.id} clip={activeClip} onClose={() => setActiveClipId(null)} />}
      </AnimatePresence>
    </>
  );
}

function PortfolioClipViewer({ clip, onClose }: { clip: PortfolioClip; onClose: () => void }) {
  const { t, locale } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const fullscreenTargetRef = useRef<HTMLDivElement>(null);
  const [stablePlaybackUrl, setStablePlaybackUrl] = useState<string | null>(
    clip.playbackStatus === "ready" ? clip.playbackUrl ?? null : null,
  );
  const [mediaFailed, setMediaFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasEnded, setHasEnded] = useState(false);
  const [muted, setMuted] = useState(true);
  const [clipDurationSec, setClipDurationSec] = useState(0);
  const [progressSec, setProgressSec] = useState(0);
  const { isFullscreen, toggleFullscreen } = useClipPlayerFullscreen(videoRef);
  const aspectRatio = portfolioClipAspectRatio(clip);

  useEffect(() => {
    if (clip.playbackStatus !== "ready") {
      setStablePlaybackUrl(null);
      return;
    }
    setStablePlaybackUrl((current) => current ?? clip.playbackUrl ?? null);
  }, [clip.playbackStatus, clip.playbackUrl]);

  useEffect(() => {
    const video = videoRef.current;
    const src = stablePlaybackUrl;
    let cancelled = false;
    if (!video) return;

    setReady(false);
    setMediaFailed(false);
    setClipDurationSec(0);
    setProgressSec(0);
    setIsPlaying(false);
    setHasEnded(false);

    const updateDuration = () => {
      const duration = video.duration;
      if (duration > 0 && Number.isFinite(duration)) setClipDurationSec(duration);
    };
    const onLoadedData = () => {
      if (cancelled) return;
      updateDuration();
      setReady(true);
      setMediaFailed(false);
      void video.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    };
    const onTimeUpdate = () => {
      updateDuration();
      setProgressSec(Math.max(0, Math.min(video.duration || 0, video.currentTime)));
    };
    const onPlay = () => {
      setHasEnded(false);
      setIsPlaying(true);
    };
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      setHasEnded(true);
      setIsPlaying(false);
      setProgressSec(video.duration || 0);
    };
    const onVideoError = () => {
      if (!cancelled) {
        setMediaFailed(true);
        setIsPlaying(false);
      }
    };

    video.addEventListener("loadedmetadata", updateDuration);
    video.addEventListener("loadeddata", onLoadedData);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onVideoError);
    if (src && clip.playbackStatus === "ready") {
      video.muted = muted;
      video.src = src;
      video.load();
    } else {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }

    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", updateDuration);
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onVideoError);
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [clip.id, stablePlaybackUrl, clip.playbackStatus]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video || !ready) return;
    if (video.paused) {
      if (video.ended || video.currentTime >= clipDurationSec) video.currentTime = 0;
      void video.play().catch(() => setIsPlaying(false));
    } else {
      video.pause();
    }
  };

  const seekWithinClip = (event: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video || !ready || clipDurationSec <= 0) return;
    const positionSec = Math.max(0, Math.min(clipDurationSec, Number(event.target.value)));
    video.currentTime = positionSec;
    setProgressSec(positionSec);
    setHasEnded(false);
  };

  const showUnavailable = mediaFailed
    || clip.playbackStatus === "expired"
    || clip.playbackStatus === "unavailable"
    || (clip.playbackStatus === "ready" && !stablePlaybackUrl && !clip.playbackUrl);
  const isPreparing = clip.playbackStatus === "processing";
  const loadingLabel = isPreparing ? t.portfolio.clipPreparing : t.portfolio.videoLoading;
  const unavailableTitle = clip.playbackStatus === "expired"
    ? t.portfolio.clipExpired
    : clip.playbackStatus === "processing"
      ? t.portfolio.clipProcessing
      : t.portfolio.videoUnavailable;
  const unavailableDescription = clip.playbackStatus === "expired"
    ? t.portfolio.clipExpiredDesc
    : clip.playbackStatus === "processing"
      ? t.portfolio.clipProcessingDesc
      : clip.playbackStatus === "ready"
        ? t.portfolio.clipUnavailableDesc
        : t.portfolio.videoUnavailableDesc;

  return (
    <motion.div className="portfolio-viewer-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div className="portfolio-viewer" initial={{ y: 24, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 24, scale: 0.98 }} onClick={(event) => event.stopPropagation()}>
        <div className="portfolio-viewer-top">
          <PortfolioMicroLabel className="is-compact">{t.portfolio.vaultCode} / <bdi dir="ltr" className="portfolio-ltr-numeric">{String(clip.id).padStart(2, "0")}</bdi></PortfolioMicroLabel>
          <button type="button" onClick={onClose} aria-label={t.portfolio.close}><X /></button>
        </div>
        <div className="portfolio-viewer-stage">
          <div
            ref={fullscreenTargetRef}
            className="portfolio-viewer-canvas"
            style={{ width: "100%", maxWidth: `${aspectRatio * 53}vh`, aspectRatio }}
          >
            <SharedClipVideo
              ref={videoRef}
              preload="auto"
              muted={muted}
              aria-label={clip.title}
              style={{ display: "block", width: "100%", height: "100%", objectFit: "cover", opacity: ready ? 1 : 0 }}
            />
            {!ready && !showUnavailable && (
              <div
                className="portfolio-viewer-loading"
                aria-hidden="true"
              >
                <div className="portfolio-viewer-loading-backdrop">
                  {clip.thumbnailUrl && <img src={clip.thumbnailUrl} alt="" />}
                </div>
                <div className="portfolio-viewer-loading-shimmer" />
                <div className="portfolio-viewer-loading-center">
                  <ReplayMark className="portfolio-loading-mark" />
                  <span
                    className="portfolio-viewer-loading-label"
                    dir={locale === "ar" ? "rtl" : "ltr"}
                    aria-hidden="true"
                  >
                    {loadingLabel}
                  </span>
                </div>
              </div>
            )}
            {!ready && !showUnavailable && (
              <span
                className="sr-only"
                role="status"
                aria-live="polite"
                dir={locale === "ar" ? "rtl" : "ltr"}
              >
                {loadingLabel}
              </span>
            )}
            {showUnavailable && (
              <div className="portfolio-viewer-message" style={{ position: "absolute", inset: 0, justifyContent: "center" }}>
                <LockKeyhole /><strong>{unavailableTitle}</strong><span>{unavailableDescription}</span>
              </div>
            )}
            {!showUnavailable && (
              <div className={cn("portfolio-viewer-controls", ready && "is-ready")}>
                <SharedClipTimeline
                  progressSec={progressSec}
                  durationSec={clipDurationSec}
                  onChange={seekWithinClip}
                  labels={{ timeline: t.varPlayer.timeline }}
                  className="portfolio-viewer-timeline"
                />
                <SharedClipPlayerButtons
                  isPlaying={isPlaying}
                  isFullscreen={isFullscreen}
                  onTogglePlayback={togglePlayback}
                  onToggleFullscreen={() => toggleFullscreen(fullscreenTargetRef.current)}
                  labels={{
                    play: t.varPlayer.play,
                    pause: t.varPlayer.pause,
                    enterFullscreen: t.varPlayer.enterFullscreen,
                    exitFullscreen: t.varPlayer.exitFullscreen,
                    timeline: t.varPlayer.timeline,
                    mute: t.varPlayer.mute,
                    unmute: t.varPlayer.unmute,
                  }}
                  playLabel={hasEnded ? t.portfolio.replayClip : t.varPlayer.play}
                  disabled={!ready}
                  muted={muted}
                  onToggleMuted={() => setMuted((value) => !value)}
                  className="portfolio-viewer-button-row"
                />
              </div>
            )}
          </div>
        </div>
        <div className="portfolio-viewer-caption"><strong className="portfolio-proper-noun"><bdi dir="auto">{clip.title}</bdi></strong><PortfolioMicroLabel className="is-compact">{t.portfolio.publicMoment}</PortfolioMicroLabel></div>
      </motion.div>
    </motion.div>
  );
}

function PortfolioEditor({
  value,
  clips,
  onClose,
  onSave,
  onClipRemoved,
}: {
  value: PortfolioState;
  clips: PortfolioClip[];
  onClose: () => void;
  onSave: (next: PortfolioState) => Promise<void>;
  onClipRemoved: (clipId: number) => void;
}) {
  const { t, locale } = useTranslation();
  const [form, setForm] = useState<PortfolioState>(value);
  const [fieldErrors, setFieldErrors] = useState<PortfolioEditorErrors>({ history: {} });
  const [error, setError] = useState("");
  const [imageNotice, setImageNotice] = useState("");
  const [imageBusy, setImageBusy] = useState(false);
  const [clipToRemove, setClipToRemove] = useState<PortfolioClip | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const updateUserClip = useUpdateUserClip();
  const setField = <K extends keyof PortfolioState>(field: K, next: PortfolioState[K]) => {
    setForm((current) => ({ ...current, [field]: next }));
    if (field !== "history") {
      setFieldErrors((current) => ({ ...current, [field]: undefined }));
    }
    setError("");
  };
  const updateHistory = (index: number, patch: Partial<PortfolioHistoryItem>) => {
    const item = form.history[index];
    if (item) {
      const changedFields = (["academy", "role", "startYear", "endYear"] as const)
        .filter((field) => field in patch);
      setFieldErrors((current) => {
        const rowErrors = current.history[item.editorId];
        if (!rowErrors) return current;
        const nextRowErrors = { ...rowErrors };
        for (const field of changedFields) delete nextRowErrors[field];
        if (changedFields.includes("startYear") || changedFields.includes("endYear")) {
          delete nextRowErrors.endYear;
        }
        return {
          ...current,
          history: { ...current.history, [item.editorId]: nextRowErrors },
        };
      });
    }
    setError("");
    setForm((current) => ({
      ...current,
      history: current.history.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    }));
  };
  const addHistory = () => {
    setFieldErrors((current) => ({ ...current, historyLimit: undefined }));
    setForm((current) => ({
      ...current,
      history: [
        ...current.history,
        {
          editorId: createPortfolioHistoryEditorId(),
          academy: "",
          role: "",
          startYear: new Date().getFullYear(),
          endYear: null,
          current: false,
          displayOrder: current.history.length,
          accent: ["lime", "teal", "violet"][current.history.length % 3] as PortfolioHistoryItem["accent"],
        },
      ],
    }));
  };
  const removeHistory = (index: number) => {
    const removedEditorId = form.history[index]?.editorId;
    if (removedEditorId) {
      setFieldErrors((current) => {
        const { [removedEditorId]: _removed, ...history } = current.history;
        return { ...current, history, historyLimit: undefined };
      });
    }
    setForm((current) => {
      return { ...current, history: current.history.filter((_, itemIndex) => itemIndex !== index) };
    });
    setError("");
  };
  const markCurrent = (index: number) => {
    const year = new Date().getFullYear();
    setForm((current) => ({
      ...current,
      history: current.history.map((item, itemIndex) => {
        const shouldMarkCurrent = current.history[index]?.current !== true;
        if (!shouldMarkCurrent) {
          return itemIndex === index ? { ...item, current: false } : item;
        }
        return {
          ...item,
          current: itemIndex === index,
          endYear: itemIndex === index ? null : item.current && item.endYear === null ? year : item.endYear,
        };
      }),
    }));
    setFieldErrors((current) => ({
      ...current,
      history: Object.fromEntries(
        Object.entries(current.history).map(([id, rowErrors]) => {
          const { isCurrent: _isCurrent, ...remainingErrors } = rowErrors;
          return [id, remainingErrors];
        }),
      ),
    }));
    setError("");
  };
  const clearImage = () => {
    const next = { ...form, profilePhoto: null };
    setForm(next);
    setFieldErrors((current) => ({ ...current, profilePhoto: undefined }));
    setError("");
  };
  const openImagePicker = () => imageInputRef.current?.click();
  const handleImageChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!isSupportedPortfolioImage(file)) {
      setImageNotice(t.portfolio.imageUploadInvalid);
      return;
    }
    setImageBusy(true);
    setImageNotice("");
    setFieldErrors((current) => ({ ...current, profilePhoto: undefined }));
    try {
       const profilePhoto = await compressPortfolioImage(file);
       const next = { ...form, profilePhoto };
      setForm(next);
    } catch {
      setImageNotice(t.portfolio.imageUploadFailed);
    } finally {
      setImageBusy(false);
    }
  };
  const submit = () => {
    const validationErrors = validatePortfolioEditor(form);
    setFieldErrors(validationErrors);
    setError("");
    if (hasPortfolioEditorErrors(validationErrors)) {
      return;
    }
    void onSave({
      ...form,
      name: form.name.trim(),
      history: form.history.map((item, index) => ({
        ...item,
        academy: item.academy.trim(),
        role: item.role.trim(),
        displayOrder: index,
      })),
    }).catch((saveError: unknown) => {
      const apiError = readPortfolioApiError(saveError);
      if (apiError.status === 413) {
        setFieldErrors((current) => ({ ...current, profilePhoto: "imageTooLarge" }));
        setError("");
        return;
      }
      if ((apiError.status === 400 || apiError.status === 422) && apiError.message) {
        const serverErrors = portfolioErrorsFromServerMessage(apiError.message, form);
        if (serverErrors) {
          setFieldErrors(serverErrors);
          setError("");
          return;
        }
      }
      setError(t.portfolio.saveFailed);
    });
  };
  const removeSharedClip = async () => {
    if (!clipToRemove) return;
    try {
      await updateUserClip.mutateAsync({ id: clipToRemove.id, data: { showInPortfolio: false } });
      onClipRemoved(clipToRemove.id);
      setClipToRemove(null);
      setError("");
    } catch {
      setError(t.portfolio.clipRemovalFailed);
    }
  };

  return (
    <motion.div className="portfolio-editor-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.aside className="portfolio-editor-drawer" dir={locale === "ar" ? "rtl" : "ltr"} initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={{ type: "spring", stiffness: 280, damping: 30 }} onClick={(event) => event.stopPropagation()}>
        <div className="portfolio-editor-grab" />
        <div className="portfolio-editor-header">
          <div>
            <PortfolioMicroLabel className="portfolio-eyebrow">{t.portfolio.editorKicker}</PortfolioMicroLabel>
            <h2>{t.portfolio.editStory}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label={t.portfolio.close}><X /></button>
        </div>
        <div className="portfolio-editor-scroll">
          <div className="portfolio-editor-photo">
             <div className="portfolio-avatar portfolio-avatar-large portfolio-photo-preview">
                {form.profilePhoto ? <img src={form.profilePhoto} alt="" /> : <CircleUserRound />}
             </div>
             <div>
                <strong>{form.profilePhoto ? t.portfolio.imageSelected : t.portfolio.imagePlaceholder}</strong>
                <span>{form.profilePhoto ? t.portfolio.imageStoredRemotely : t.portfolio.imagePlaceholderDesc}</span>
             </div>
             <div className="portfolio-photo-actions">
               <input ref={imageInputRef} type="file" accept="image/*" onChange={handleImageChange} hidden />
                 <button type="button" className="portfolio-outline-button" onClick={openImagePicker} disabled={imageBusy}><PortfolioMicroLabel className="is-compact">{imageBusy ? t.portfolio.imageProcessing : form.profilePhoto ? t.portfolio.imageReplace : t.portfolio.imageUpload}</PortfolioMicroLabel></button>
                {form.profilePhoto && <button type="button" className="portfolio-icon-button" onClick={clearImage} aria-label={t.portfolio.imageRemove}><Trash2 /></button>}
             </div>
          </div>
            {form.profilePhoto && <button type="button" className="portfolio-use-placeholder" onClick={clearImage}><PortfolioMicroLabel className="is-compact">{t.portfolio.usePlaceholder}</PortfolioMicroLabel></button>}
           {imageNotice && <p className="portfolio-editor-notice" role="status">{imageNotice}</p>}
           {fieldErrors.profilePhoto && <p className="portfolio-editor-field-error" role="alert">{t.portfolio[fieldErrors.profilePhoto]}</p>}
          <label className="portfolio-field">
             <PortfolioMicroLabel className="is-compact">{t.portfolio.name}</PortfolioMicroLabel>
             <input value={form.name} aria-invalid={Boolean(fieldErrors.name)} onChange={(event) => setField("name", event.target.value)} />
             {fieldErrors.name && <span className="portfolio-editor-field-error" role="alert">{t.portfolio[fieldErrors.name]}</span>}
          </label>
          <div className="portfolio-editor-grid">
              <label className="portfolio-field"><PortfolioMicroLabel className="is-compact">{t.portfolio.age}</PortfolioMicroLabel><input className="portfolio-ltr-numeric" dir="ltr" type="number" min={5} max={100} value={form.age ?? ""} aria-invalid={Boolean(fieldErrors.age)} onChange={(event) => setField("age", event.target.value ? Number(event.target.value) : null)} />{fieldErrors.age && <span className="portfolio-editor-field-error" role="alert">{t.portfolio[fieldErrors.age]}</span>}</label>
               <label className="portfolio-field"><PortfolioMicroLabel className="is-compact">{t.portfolio.nation}</PortfolioMicroLabel><input dir="auto" value={form.nation} aria-invalid={Boolean(fieldErrors.nation)} onChange={(event) => setField("nation", event.target.value)} />{fieldErrors.nation && <span className="portfolio-editor-field-error" role="alert">{t.portfolio[fieldErrors.nation]}</span>}</label>
          </div>
            <label className="portfolio-field"><PortfolioMicroLabel className="is-compact">{t.portfolio.position}</PortfolioMicroLabel><span className="portfolio-select-wrap"><select value={positionLabelKey(form.position)} aria-invalid={Boolean(fieldErrors.position)} onChange={(event) => setField("position", event.target.value)}>{POSITION_KEYS.map((key) => <option key={key} value={key}>{t.onboarding.positions[key]}</option>)}</select><ChevronDown /></span>{fieldErrors.position && <span className="portfolio-editor-field-error" role="alert">{t.portfolio[fieldErrors.position]}</span>}</label>
           <div className="portfolio-field">
             <div className="portfolio-editor-section-heading">
                <PortfolioMicroLabel className="is-compact">{t.portfolio.teamsAcademies}</PortfolioMicroLabel>
                 <button type="button" className="portfolio-add-history" onClick={addHistory} disabled={form.history.length >= 20}><Plus /> <PortfolioMicroLabel className="is-compact">{t.portfolio.addAcademy}</PortfolioMicroLabel></button>
             </div>
              {fieldErrors.historyLimit && <p className="portfolio-editor-field-error" role="alert">{t.portfolio[fieldErrors.historyLimit]}</p>}
             <div className="portfolio-editor-history">
               {form.history.map((item, index) => (
                  <div className="portfolio-history-edit-card" key={item.editorId}>
                   <div className="portfolio-history-edit-heading">
                     <bdi dir="ltr" className={cn("portfolio-history-marker", "portfolio-ltr-numeric", `is-${item.accent}`)}>{String(index + 1).padStart(2, "0")}</bdi>
                      <PortfolioMicroLabel className="is-compact">{item.current ? t.portfolio.currentTeam : t.portfolio.pastTeam}</PortfolioMicroLabel>
                     <button type="button" className="portfolio-icon-button" onClick={() => removeHistory(index)} aria-label={t.portfolio.removeAcademy}><Trash2 /></button>
                   </div>
                     <label><PortfolioMicroLabel className="is-compact">{t.portfolio.academyName}</PortfolioMicroLabel><input dir="auto" value={item.academy} aria-invalid={Boolean(fieldErrors.history[item.editorId]?.academy)} onChange={(event) => updateHistory(index, { academy: event.target.value })} />{fieldErrors.history[item.editorId]?.academy && <span className="portfolio-editor-field-error" role="alert">{t.portfolio[fieldErrors.history[item.editorId]!.academy!]}</span>}</label>
                     <label><PortfolioMicroLabel className="is-compact">{t.portfolio.roleLabel}</PortfolioMicroLabel><input dir="auto" value={item.role === "firstTeam" ? t.portfolio.roles.firstTeam : item.role === "developmentSquad" ? t.portfolio.roles.developmentSquad : item.role === "academyPlayer" ? t.portfolio.roles.academyPlayer : item.role} aria-invalid={Boolean(fieldErrors.history[item.editorId]?.role)} onChange={(event) => updateHistory(index, { role: event.target.value })} />{fieldErrors.history[item.editorId]?.role && <span className="portfolio-editor-field-error" role="alert">{t.portfolio[fieldErrors.history[item.editorId]!.role!]}</span>}</label>
                   <div className="portfolio-editor-year-grid">
                       <label><PortfolioMicroLabel className="is-compact">{t.portfolio.startYear}</PortfolioMicroLabel><input className="portfolio-ltr-numeric" dir="ltr" inputMode="numeric" type="number" min={1900} max={2100} value={item.startYear} aria-invalid={Boolean(fieldErrors.history[item.editorId]?.startYear)} onChange={(event) => updateHistory(index, { startYear: Number(event.target.value) })} />{fieldErrors.history[item.editorId]?.startYear && <span className="portfolio-editor-field-error" role="alert">{t.portfolio[fieldErrors.history[item.editorId]!.startYear!]}</span>}</label>
                       <label><PortfolioMicroLabel className="is-compact">{t.portfolio.endYear}</PortfolioMicroLabel><input className="portfolio-ltr-numeric" dir="ltr" inputMode="numeric" type="number" min={1900} max={2100} value={item.endYear ?? ""} disabled={item.current} aria-invalid={Boolean(fieldErrors.history[item.editorId]?.endYear)} onChange={(event) => updateHistory(index, { endYear: event.target.value ? Number(event.target.value) : null })} />{fieldErrors.history[item.editorId]?.endYear && <span className="portfolio-editor-field-error" role="alert">{t.portfolio[fieldErrors.history[item.editorId]!.endYear!]}</span>}</label>
                   </div>
                     <button type="button" className={cn("portfolio-current-toggle", item.current && "is-selected")} onClick={() => markCurrent(index)} aria-pressed={item.current}><Check /> <PortfolioMicroLabel className="is-compact">{item.current ? t.portfolio.currentTeam : t.portfolio.markCurrent}</PortfolioMicroLabel></button>
                     {fieldErrors.history[item.editorId]?.isCurrent && <span className="portfolio-editor-field-error" role="alert">{t.portfolio[fieldErrors.history[item.editorId]!.isCurrent!]}</span>}
                 </div>
               ))}
             </div>
           </div>
           <div className="portfolio-field">
             <div className="portfolio-editor-section-heading">
               <PortfolioMicroLabel className="is-compact">{t.portfolio.sharedClips}</PortfolioMicroLabel>
             </div>
             {clips.length === 0 ? (
               <div className="portfolio-shared-clips-empty">
                 <PortfolioMicroLabel className="is-caption">{t.portfolio.sharedClipsEmpty}</PortfolioMicroLabel>
               </div>
             ) : (
               <div className="portfolio-shared-clips">
                 {clips.map((clip) => (
                   <div className="portfolio-shared-clip-row" key={clip.id}>
                     <div className="portfolio-shared-clip-thumb">
                       {clip.thumbnailUrl ? <img src={clip.thumbnailUrl} alt="" /> : <span>R</span>}
                     </div>
                     <div className="portfolio-shared-clip-copy">
                       <strong><bdi dir="auto">{clip.title}</bdi></strong>
                       <PortfolioMicroLabel className="is-compact">{t.portfolio.publicMoment}</PortfolioMicroLabel>
                     </div>
                     <button
                       type="button"
                       className="portfolio-icon-button"
                       onClick={() => setClipToRemove(clip)}
                       aria-label={t.portfolio.removeClip}
                       title={t.portfolio.removeClip}
                     >
                       <Trash2 />
                     </button>
                   </div>
                 ))}
               </div>
             )}
           </div>
          {error && <p className="portfolio-editor-error">{error}</p>}
        </div>
         <div className="portfolio-editor-footer"><button type="button" className="portfolio-save-button" onClick={submit}><Check /> <PortfolioMicroLabel className="is-compact">{t.portfolio.saveAndReturn}</PortfolioMicroLabel></button></div>
      </motion.aside>
       <AnimatePresence>
         {clipToRemove && (
           <motion.div
             initial={{ opacity: 0 }}
             animate={{ opacity: 1 }}
             exit={{ opacity: 0 }}
             className="absolute inset-0 z-30 flex items-center justify-center bg-black/80 p-4"
             role="alertdialog"
             aria-modal="true"
             aria-labelledby="portfolio-editor-remove-title"
             onClick={(event) => event.stopPropagation()}
           >
             <motion.div
               initial={{ scale: 0.96, y: 8 }}
               animate={{ scale: 1, y: 0 }}
               exit={{ scale: 0.96, y: 8 }}
               className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0d1518] p-5 shadow-2xl"
             >
               <h2 id="portfolio-editor-remove-title" className="text-sm font-bold text-white">
                 {t.portfolio.removeSharedClipTitle}
               </h2>
               <p className="mt-2 text-xs leading-relaxed text-white/65">
                 {t.portfolio.removeSharedClipDesc}
               </p>
               <div className="mt-4 flex justify-end gap-2">
                 <button
                   type="button"
                   disabled={updateUserClip.isPending}
                   onClick={() => setClipToRemove(null)}
                   className="rounded-lg bg-white/10 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
                 >
                   {t.myClips.cancel}
                 </button>
                 <button
                   type="button"
                   disabled={updateUserClip.isPending}
                   onClick={() => void removeSharedClip()}
                   className="rounded-lg bg-[#ff8068] px-3 py-2 text-xs font-semibold text-[#160908] disabled:opacity-50"
                 >
                   {t.portfolio.removeClip}
                 </button>
               </div>
             </motion.div>
           </motion.div>
         )}
       </AnimatePresence>
    </motion.div>
  );
}

function isSupportedPortfolioImage(file: File): boolean {
  if (file.type.startsWith("image/")) {
    return /image\/(?:jpeg|jpg|png|webp|heic|heif)$/i.test(file.type);
  }
  return /\.(?:jpe?g|png|webp|heic|heif)$/i.test(file.name);
}

function compressPortfolioImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    const cleanup = () => URL.revokeObjectURL(objectUrl);
    image.onload = () => {
      const longEdge = Math.max(image.naturalWidth, image.naturalHeight);
      if (!longEdge) {
        cleanup();
        reject(new Error("Image has no dimensions"));
        return;
      }
      const scale = Math.min(1, 2000 / longEdge);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        cleanup();
        reject(new Error("Canvas unavailable"));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      let hasTransparency = false;
      try {
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let index = 3; index < pixels.length; index += 4) {
          if (pixels[index] < 255) {
            hasTransparency = true;
            break;
          }
        }
      } catch {
        cleanup();
        reject(new Error("Image alpha could not be inspected"));
        return;
      }
      const dataUrl = hasTransparency
        ? (() => {
          const webp = canvas.toDataURL("image/webp", 0.85);
          return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", 0.85);
        })()
        : (() => {
          const jpeg = canvas.toDataURL("image/jpeg", 0.85);
          return jpeg.startsWith("data:image/jpeg") ? jpeg : canvas.toDataURL("image/webp", 0.85);
        })();
      cleanup();
      if (!dataUrl.startsWith("data:image/")) {
        reject(new Error("Image export failed"));
      } else {
        resolve(dataUrl);
      }
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("Image decode failed"));
    };
    image.src = objectUrl;
  });
}