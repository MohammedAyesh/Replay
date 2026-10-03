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

/**
 * Who else already picked this person: the owners other than the viewer's
 * own identity. Picking someone another player picked is allowed (both are
 * counted); the flow asks first.
 */
export function otherClaimOwners(
  memberTrackIds: string[],
  identities: ClaimStatusIdentity[],
  ownIdentityId: string | null,
  ownName: string | null,
): Array<{ identityId: string; name: string }> {
  return claimStatusForGroup(memberTrackIds, identities, ownIdentityId, ownName).owners
    .filter((owner) => owner.identityId !== ownIdentityId && Boolean(owner.name))
    .map((owner) => ({ identityId: owner.identityId, name: owner.name as string }));
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