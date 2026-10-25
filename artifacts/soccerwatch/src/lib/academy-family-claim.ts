/**
 * Which family-link claim the invite page should send next, or null when this one
 * has already been sent. A claim is identified by the token and the retry attempt,
 * so "Try again" (which bumps the attempt) sends the same token once more, while a
 * re-render or auth refresh never sends a duplicate.
 */
export function nextFamilyClaimKey(lastSentKey: string | null, token: string, attempt: number): string | null {
  if (!token) return null;
  const key = `${attempt}:${token}`;
  return key === lastSentKey ? null : key;
}
