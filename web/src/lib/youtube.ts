// Extracts a YouTube video id from the various URL shapes Discogs' video
// links come in (watch?v=, youtu.be/, embed/, shorts/), for building an
// embeddable player URL.
export function youtubeEmbedUrl(url: string): string | null {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/);
  if (!match) return null;
  return `https://www.youtube.com/embed/${match[1]}`;
}
