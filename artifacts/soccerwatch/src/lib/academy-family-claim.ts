export async function retryAcademyFamilyClaim(
  token: string,
  claim: (token: string) => Promise<{ playerId: number }>,
  navigate: (path: string) => void,
): Promise<void> {
  const result = await claim(token);
  navigate(`/academy/me?playerId=${result.playerId}`);
}
