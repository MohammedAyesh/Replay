/**
 * A claim write found, inside its row lock, that the tracking bundle is no
 * longer the one the request was built from: a re-analysis landed between
 * the request reading the bundle and writing it. Writing anyway would put
 * the old bundle's track ids into the new manifest, so the write is refused
 * and the client is told to reload -- the same 409 the routes already send
 * when the client itself names an old bundle fingerprint.
 */
import type { NextFunction, Request, Response } from "express";

export class ClaimBundleChangedError extends Error {
  readonly currentBundleFingerprint: string;

  constructor(currentBundleFingerprint: string) {
    super("The tracking bundle changed while the claim was being saved");
    this.name = "ClaimBundleChangedError";
    this.currentBundleFingerprint = currentBundleFingerprint;
  }
}

/** The body of every "this recording's tracking has been replaced" 409. */
export function bundleReplacedBody(currentBundleFingerprint: string) {
  return {
    error: "This recording's tracking has been replaced. Reload before continuing your claim.",
    currentBundleFingerprint,
  };
}

export function sendBundleReplaced(res: Response, currentBundleFingerprint: string): void {
  res.status(409).json(bundleReplacedBody(currentBundleFingerprint));
}

/** Express error middleware: a ClaimBundleChangedError thrown by a route is a 409, not a 500. */
export function claimBundleChangedErrorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (error instanceof ClaimBundleChangedError && !res.headersSent) {
    sendBundleReplaced(res, error.currentBundleFingerprint);
    return;
  }
  next(error);
}
