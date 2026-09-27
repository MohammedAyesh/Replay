export type ClaimStatusIdentity = {
  id: string;
  name: string | null;
  parts: Array<{ trackId: string }>;
};

export type GroupClaimStatus = {
  taken: boolean;
  owners: Array<{ identityId: string; name: string | null }>;
};

export function claimStatusForGroup(
  memberTrackIds: string[],
  identities: ClaimStatusIdentity[],
  ownIdentityId: string | null,
  ownName: string | null,
): GroupClaimStatus {
  const members = new Set(memberTrackIds);
  const owners = new Map<string, { identityId: string; name: string | null }>();

  for (const identity of identities) {
    if (!identity.name && identity.id !== ownIdentityId) continue;
    if (!identity.parts.some((part) => members.has(part.trackId))) continue;
    owners.set(identity.id, {
      identityId: identity.id,
      name: identity.id === ownIdentityId ? identity.name || ownName : identity.name,
    });
  }

  return { taken: owners.size > 0, owners: [...owners.values()] };
}

export function claimCountsForGroups(
  groups: Array<{ members: string[] }>,
  identities: ClaimStatusIdentity[],
  ownIdentityId: string | null,
  ownName: string | null,
): { free: number; taken: number } {
  const taken = groups.filter((group) =>
    claimStatusForGroup(group.members, identities, ownIdentityId, ownName).taken).length;
  return { free: groups.length - taken, taken };
}