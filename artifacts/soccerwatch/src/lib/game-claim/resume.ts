/** Load the active chunk before returning; start other saved chunks in the background. */
export async function loadResumeChunks(
  currentChunk: number | null,
  chunkKeys: number[],
  ensure: (chunk: number) => Promise<unknown>,
): Promise<void> {
  if (currentChunk !== null) await ensure(currentChunk);
  for (const chunk of chunkKeys) {
    if (chunk === currentChunk) continue;
    void ensure(chunk).catch(() => {});
  }
}
