export function seekVideoElement(video: HTMLVideoElement | null, seconds: number) {
  if (!video || !Number.isFinite(seconds) || seconds < 0) return;
  const seek = () => {
    if (!video.isConnected) return;
    const upperBound = Number.isFinite(video.duration) && video.duration > 0
      ? Math.max(0, video.duration - 0.05)
      : seconds;
    video.currentTime = Math.min(upperBound, seconds);
  };
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
  else video.addEventListener("loadedmetadata", seek, { once: true });
}
