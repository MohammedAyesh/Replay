export function getBunnyMp4FallbackSource(playbackUrl: string, videoId: string): string | null {
  try {
    const playlistUrl = new URL(playbackUrl);
    const expectedPath = `/${encodeURIComponent(videoId)}/playlist.m3u8`;
    if (
      playlistUrl.protocol !== "https:"
      || !playlistUrl.hostname.endsWith(".b-cdn.net")
      || playlistUrl.pathname !== expectedPath
      || !videoId
    ) {
      return null;
    }

    const mp4Url = new URL(`/${encodeURIComponent(videoId)}/play_720p.mp4`, playlistUrl.origin).toString();
    return `/api/hls-proxy/segment?url=${encodeURIComponent(mp4Url)}`;
  } catch {
    return null;
  }
}
