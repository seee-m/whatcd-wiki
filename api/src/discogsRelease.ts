// Discogs release "extras": a link to the matching Discogs release page,
// plus any videos Discogs has attached to it (their own release pages
// show a "Videos" sidebar of user-submitted YouTube links -- usually the
// album itself, live performances, etc.). Music-only -- gated by the
// caller (routes/torrents.ts) to releases with categoryId === 1, same as
// cover art. Needs DISCOGS_TOKEN; returns null without it. Cached in
// release_extras by the caller so this is at most two Discogs calls
// (search + release detail) per release, ever.

import { APP_UA, fetchWithTimeout } from './httpUtil.js';
import { throttleDiscogs } from './discogsThrottle.js';

export interface DiscogsExtras {
  discogsUrl: string;
  videos: { url: string; title: string }[];
}

// Discogs' own search relevance ranking can't be trusted blindly -- it has
// returned a release whose artist and title share no resemblance at all
// with the query (whatcd release 73159108, "Creeper - Contrast", a 2016 UK
// rock release, top-ranked against a 2009 Various-artist drum & bass
// compilation called "Big In The Game Drum & Bass"). This is a much
// lighter check than import-discogs-videos.mjs's full MATCH_RULES ladder --
// this is a live, per-request lookup against whatever Discogs' search
// returns, not an offline bulk match against a downloaded index -- but it's
// enough to reject a hit that's obviously a different record. Compacted
// (whitespace stripped, not just collapsed) so punctuation-only spelling
// differences ("Run-D.M.C." vs "RUN DMC") still resemble each other.
function compact(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function resembles(query: string, candidate: string): boolean {
  const a = compact(query);
  const b = compact(candidate);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}

// Checked against the search result's own release detail (title + artists),
// which the caller fetches anyway to read videos -- no extra Discogs call
// needed to verify a candidate.
function isPlausibleMatch(
  artist: string,
  title: string,
  detail: { title?: string; artists?: { name?: string }[] },
): boolean {
  const candidateArtist = detail.artists?.map((a) => a.name).filter(Boolean).join(' & ') ?? '';
  return resembles(artist, candidateArtist) && resembles(title, detail.title ?? '');
}

export async function fetchDiscogsExtras(artist: string, title: string): Promise<DiscogsExtras | null> {
  const token = process.env.DISCOGS_TOKEN;
  if (!token) return null;

  const searchUrl = `https://api.discogs.com/database/search?q=${encodeURIComponent(`${artist} ${title}`)}&type=release&token=${token}`;
  const searchRes = await throttleDiscogs(() => fetchWithTimeout(searchUrl, { headers: { 'User-Agent': APP_UA } }));
  if (!searchRes.ok) return null;
  const searchData = (await searchRes.json()) as { results?: { id?: number }[] };
  const candidateIds = (searchData.results ?? []).map((r) => r.id).filter((id): id is number => !!id);

  // Try the next-ranked search result when the top one turns out to be a
  // different record entirely, instead of giving up the moment rank 1 fails
  // verification. Capped at 5 -- same cap the old unverified code effectively
  // had (it only ever looked at rank 1), so this only adds Discogs calls in
  // the case that used to silently return a wrong match for free.
  for (const id of candidateIds.slice(0, 5)) {
    const detailRes = await throttleDiscogs(() =>
      fetchWithTimeout(`https://api.discogs.com/releases/${id}?token=${token}`, {
        headers: { 'User-Agent': APP_UA },
      }),
    );
    if (!detailRes.ok) continue;
    const detail = (await detailRes.json()) as {
      title?: string;
      artists?: { name?: string }[];
      videos?: { uri?: string; title?: string }[];
    };
    if (!isPlausibleMatch(artist, title, detail)) continue;

    const videos = (detail.videos ?? [])
      .filter((v): v is { uri: string; title: string } => !!v.uri)
      .slice(0, 5)
      .map((v) => ({ url: v.uri, title: v.title ?? 'Video' }));

    return { discogsUrl: `https://www.discogs.com/release/${id}`, videos };
  }

  return null;
}
