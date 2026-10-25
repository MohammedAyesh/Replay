export async function enterKitAfterLoadingCurrentChunk(
  chunk: number | null,
  ensure: (chunk: number) => Promise<unknown>,
  navigate: (step: "kit") => void,
): Promise<void> {
  if (chunk === null) return;
  await ensure(chunk);
  navigate("kit");
}
