import type { BrandingKind, BrandingScopeType } from "@workspace/db";

/**
 * Choosing the branding for one clip, and plugging it into the render.
 *
 * Nothing here touches the database or ffmpeg — those are the caller's job.
 * What lives here is the two decisions that are easy to get quietly wrong: which
 * of several candidate assets wins, and how the overlay is spliced into a filter
 * graph that already has strong opinions about geometry.
 */

export type BrandingCandidate = {
  scopeType: BrandingScopeType;
  scopeId: number;
  kind: BrandingKind;
  assetUrl: string;
  width: number | null;
  height: number | null;
};

export type BrandingScope = {
  academyId?: number | null;
  fieldId?: number | null;
};

/**
 * Academy, then field, then global — the same order the academy intro uses.
 *
 * Deliberately not "most specific asset of any kind wins per kind
 * independently": an academy that has uploaded an overlay but no end card gets
 * the field's end card, because the alternative is a clip with an academy's
 * logo and no sign-off at all. Branding degrades to the next tier out, one
 * piece at a time.
 */
export function chooseBrandingAsset(
  candidates: readonly BrandingCandidate[],
  kind: BrandingKind,
  scope: BrandingScope,
): BrandingCandidate | null {
  const forKind = candidates.filter((c) => c.kind === kind);
  const academyId = scope.academyId ?? null;
  const fieldId = scope.fieldId ?? null;

  return (
    (academyId !== null
      ? forKind.find((c) => c.scopeType === "academy" && c.scopeId === academyId)
      : undefined) ??
    (fieldId !== null
      ? forKind.find((c) => c.scopeType === "field" && c.scopeId === fieldId)
      : undefined) ??
    forKind.find((c) => c.scopeType === "global") ??
    null
  );
}

/**
 * Does this overlay match the geometry it will be composited onto?
 *
 * An overlay is drawn at 0,0 with no scaling, on purpose: scaling a logo to fit
 * would silently change its proportions and its position, and a brand mark that
 * moves between a 16:9 and a 9:16 export is worse than one that is missing. So
 * a mismatch is reported rather than corrected, and the console shows it before
 * anyone exports a hundred clips with a logo in the wrong corner.
 */
export function overlayFits(
  asset: Pick<BrandingCandidate, "width" | "height">,
  output: { w: number; h: number },
): boolean {
  if (asset.width == null || asset.height == null) return true; // unprobed: trust it
  return asset.width === output.w && asset.height === output.h;
}

/**
 * Splice an overlay into the clip's existing filter chain.
 *
 * The crop chain is used verbatim — it pads, pans and scales, and every crop
 * keyframe is a fraction multiplied by the source geometry, so rewriting any
 * part of it produces a silently mis-framed clip. It becomes `[base]`, the
 * overlay is drawn over it at 0,0, and the result is `[v]`.
 *
 * Returned as a filter_complex body rather than a `-vf` string because the crop
 * chain for a multi-keyframe pan is already long enough to need a script file;
 * anything built from it needs the same escape hatch.
 */
export function buildOverlayFilterComplex(cropFilter: string): string {
  return `[0:v]${cropFilter}[base];[base][1:v]overlay=0:0:format=auto[v]`;
}
