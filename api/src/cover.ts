// Cover art lookup, tried in order until one succeeds:
//   1. iTunes Search API (free, no key, no rate limit we need to respect)
//   2. Discogs (free, needs a personal token -- DISCOGS_TOKEN, 60 req/min)
//   3. MusicBrainz -> Cover Art Archive (free, no key, but asks for ~1
//      req/sec globally -- tried last since that serialized queue is the
//      slow path; most releases resolve via 1 or 2 well before reaching it)
// Results are cached in release_covers by the caller (routes/torrents.ts)
// so none of these ever get hit twice for the same release.

import { APP_UA, fetchWithTimeout } from './httpUtil.js';
import { throttleDiscogs } from './discogsThrottle.js';
import { resembles } from './discogsMatch.js';

// MusicBrainz asks for at most ~1 req/sec from unauthenticated clients.
// A simple serialized delay is enough for a personal app's traffic.
let musicBrainzQueue: Promise<void> = Promise.resolve();
function throttleMusicBrainz<T>(fn: () => Promise<T>): Promise<T> {
  const run = musicBrainzQueue.then(fn);
  musicBrainzQueue = run.then(
    () => new Promise((resolve) => setTimeout(resolve, 1100)),
    () => new Promise((resolve) => setTimeout(resolve, 1100)),
  );
  return run;
}

export interface CoverResult {
  url: string;
  source: string;
}

async function tryItunes(artist: string, title: string): Promise<CoverResult | null> {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${title}`)}&entity=album&limit=1`;
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': APP_UA } });
  if (!res.ok) return null;
  const data = (await res.json()) as { results?: { artworkUrl100?: string }[] };
  const art = data.results?.[0]?.artworkUrl100;
  if (!art) return null;
  return { url: art.replace('100x100bb', '600x600bb'), source: 'itunes' };
}

async function tryDiscogs(artist: string, title: string): Promise<CoverResult | null> {
  const token = process.env.DISCOGS_TOKEN;
  if (!token) return null;
  const url = `https://api.discogs.com/database/search?q=${encodeURIComponent(`${artist} ${title}`)}&type=release&token=${token}`;
  const res = await throttleDiscogs(() => fetchWithTimeout(url, { headers: { 'User-Agent': APP_UA } }));
  if (!res.ok) return null;
  const data = (await res.json()) as { results?: { id?: number; title?: string; cover_image?: string; thumb?: string }[] };

  // Same blind-search flaw fixed in discogsRelease.ts: Discogs' relevance
  // ranking has put a completely unrelated release first (see that file's
  // comment). The search endpoint's own `title` field comes back as
  // "Artist - Release Title" -- enough to verify without a second (detail)
  // API call, unlike the extras path which already needs the detail call
  // for videos. Tries the next-ranked result when the top one doesn't
  // resemble the query, capped at 5 for the same reason as discogsRelease.ts.
  for (const result of (data.results ?? []).slice(0, 5)) {
    const art = result.cover_image || result.thumb;
    if (!art || !result.title) continue;
    if (!resembles(artist, result.title) || !resembles(title, result.title)) continue;
    return { url: art, source: 'discogs' };
  }
  return null;
}

async function tryMusicBrainz(artist: string, title: string): Promise<CoverResult | null> {
  return throttleMusicBrainz(async () => {
    const query = `releasegroup:"${title}" AND artist:"${artist}"`;
    const searchUrl = `https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(query)}&fmt=json&limit=1`;
    const res = await fetchWithTimeout(searchUrl, { headers: { 'User-Agent': APP_UA } });
    if (!res.ok) return null;
    const data = (await res.json()) as { 'release-groups'?: { id: string }[] };
    const mbid = data['release-groups']?.[0]?.id;
    if (!mbid) return null;

    const caaUrl = `https://coverartarchive.org/release-group/${mbid}/front-500`;
    const caaRes = await fetchWithTimeout(caaUrl, { method: 'HEAD', headers: { 'User-Agent': APP_UA } });
    if (!caaRes.ok) return null;
    return { url: caaUrl, source: 'musicbrainz' };
  });
}

export async function fetchCover(artist: string, title: string): Promise<CoverResult | null> {
  for (const provider of [tryItunes, tryDiscogs, tryMusicBrainz]) {
    try {
      const result = await provider(artist, title);
      if (result) return result;
    } catch {
      // Network hiccup, timeout, or provider outage -- move on to the next provider.
    }
  }
  return null;
}
