import Hls from "hls.js";
import { useEffect, useRef } from "react";

export type VideoPlayerProps = {
  hlsUrl: string;
  posterUrl?: string | null;
  className?: string;
  autoPlay?: boolean;
};

export function VideoPlayer({ hlsUrl, posterUrl, className, autoPlay = false }: VideoPlayerProps) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = hlsUrl;
      return () => {
        video.removeAttribute("src");
        video.load();
      };
    }
    if (!Hls.isSupported()) return;
    const hls = new Hls();
    hls.loadSource(hlsUrl);
    hls.attachMedia(video);
    return () => {
      hls.destroy();
    };
  }, [hlsUrl]);

  return (
    <video
      ref={ref}
      className={className}
      poster={posterUrl ?? undefined}
      controls
      playsInline
      preload="metadata"
      autoPlay={autoPlay}
      muted={autoPlay}
    />
  );
}
