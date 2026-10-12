/** Keep page-exit saves nonblocking; normal saves wait for all claimed chunks. */
export function sendClaimSave<T>(
  chunksNeeded: number[],
  keepalive: boolean,
  loadChunk: (chunk: number) => Promise<unknown>,
  send: (includeParts: boolean) => Promise<T>,
): Promise<T> {
  if (keepalive) return send(chunksNeeded.length === 0);
  return Promise.all(chunksNeeded.map(loadChunk)).then(() => send(true));
}
