// Discogs release "extras": a link to the matching Discogs release page,
// plus any videos Discogs has attached to it (their own release pages
// show a "Videos" sidebar of user-submitted YouTube links -- usually the
// album itself, live performances, etc.). Music-only -- gated by the
// caller (routes/torrents.ts) to releases with categoryId === 1, same as
// cover art. Needs DISCOGS_TOKEN; returns null without it. Cached in
// release_extras by the caller so this is at most two Discogs calls
// (search + release detail) per release, ever.

import { APP_UA, fetchWithTimeout } from './httpUtil.js';

export interface DiscogsExtras {
  discogsUrl: string;
  videos: { url: string; title: string }[];
}

export async function fetchDiscogsExtras(artist: string, title: string): Promise<DiscogsExtras | null> {
  const token = process.env.DISCOGS_TOKEN;
  if (!token) return null;

  const searchUrl = `https://api.discogs.com/database/search?q=${encodeURIComponent(`${artist} ${title}`)}&type=release&token=${token}`;
  const searchRes = await fetchWithTimeout(searchUrl, { headers: { 'User-Agent': APP_UA } });
  if (!searchRes.ok) return null;
  const searchData = (await searchRes.json()) as { results?: { id?: number }[] };
  const id = searchData.results?.[0]?.id;
  if (!id) return null;

  const detailRes = await fetchWithTimeout(`https://api.discogs.com/releases/${id}?token=${token}`, {
    headers: { 'User-Agent': APP_UA },
  });
  if (!detailRes.ok) return null;
  const detail = (await detailRes.json()) as { videos?: { uri?: string; title?: string }[] };

  const videos = (detail.videos ?? [])
    .filter((v): v is { uri: string; title: string } => !!v.uri)
    .slice(0, 5)
    .map((v) => ({ url: v.uri, title: v.title ?? 'Video' }));

  return { discogsUrl: `https://www.discogs.com/release/${id}`, videos };
}
