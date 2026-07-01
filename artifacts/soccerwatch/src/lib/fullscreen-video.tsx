import { createContext, useContext, useState, useCallback } from "react";

interface FullscreenVideoContextType {
  isFullscreenVideo: boolean;
  setFullscreenVideo: (v: boolean) => void;
}

const FullscreenVideoContext = createContext<FullscreenVideoContextType>({
  isFullscreenVideo: false,
  setFullscreenVideo: () => {},
});

export function FullscreenVideoProvider({ children }: { children: React.ReactNode }) {
  const [isFullscreenVideo, setFullscreenVideo] = useState(false);
  const setter = useCallback((v: boolean) => setFullscreenVideo(v), []);
  return (
    <FullscreenVideoContext.Provider value={{ isFullscreenVideo, setFullscreenVideo: setter }}>
      {children}
    </FullscreenVideoContext.Provider>
  );
}

export function useFullscreenVideo() {
  return useContext(FullscreenVideoContext);
}
