// Extracts a YouTube video id from the various URL shapes Discogs' video
// links come in (watch?v=, youtu.be/, embed/, shorts/).
export function youtubeVideoId(url: string): string | null {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/);
  return match ? match[1] : null;
}

export function youtubeEmbedUrl(url: string): string | null {
  const id = youtubeVideoId(url);
  return id ? `https://www.youtube.com/embed/${id}` : null;
}

// Minimal surface of the YouTube IFrame Player API this app actually uses.
// what.tv (see pages/TvPlay.tsx) needs the real JS API rather than a plain
// <iframe src>, because "autoplay the next track when this one ends"
// requires an onStateChange callback -- a bare iframe has no way to signal
// that back to the page.
export interface YouTubePlayer {
  loadVideoById(videoId: string): void;
  destroy(): void;
}

interface YouTubePlayerEvent {
  data: number;
  target: YouTubePlayer;
}

interface YouTubeNamespace {
  Player: new (
    el: HTMLElement | string,
    opts: {
      videoId: string;
      playerVars?: Record<string, number | string>;
      events?: {
        onReady?: (e: YouTubePlayerEvent) => void;
        onStateChange?: (e: YouTubePlayerEvent) => void;
        // Fires for a dead video (removed, privated, or embedding disabled
        // by the owner -- codes 100, 101, 150) as well as bad requests (2)
        // and playback errors (5). what.tv treats all of these the same:
        // this video isn't playable, prune it and move on.
        onError?: (e: YouTubePlayerEvent) => void;
      };
    },
  ) => YouTubePlayer;
  PlayerState: { ENDED: number };
}

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YouTubeNamespace> | null = null;

// Loads https://www.youtube.com/iframe_api at most once per page, and
// chains onto any onYouTubeIframeAPIReady callback a *different* embed
// (e.g. a future feature) might also be waiting on, instead of clobbering it.
export function loadYouTubeIframeApi(): Promise<YouTubeNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT!);
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
  return apiPromise;
}
