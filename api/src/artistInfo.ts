// Best-effort artist photo + short bio, tried in order until something is
// found:
//   1. Wikipedia's REST summary API (free, no key, one fast call, returns
//      an extract AND a thumbnail together -- no per-request rate limit)
//   2. Discogs artist search (free, needs DISCOGS_TOKEN) -- image only,
//      used to fill in a photo when Wikipedia had a bio but no thumbnail
// This is explicitly a substitute for the site's own editor-curated
// artist images/bios (stored in a `wiki_artists` table this dump doesn't
// include at all -- see the plan/conversation) -- not restored data.
// Results are cached in artist_info by the caller (routes/artists.ts) so
// neither provider is ever hit twice for the same artist.

const APP_UA = 'whatcd-wiki-archive/1.0 (+local personal-use archive browser)';
const FETCH_TIMEOUT_MS = 4000;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface ArtistInfoResult {
  bio: string | null;
  image: string | null;
  source: string;
}

async function tryWikipedia(name: string): Promise<ArtistInfoResult | null> {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`;
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': APP_UA } });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    type?: string;
    extract?: string;
    thumbnail?: { source?: string };
  };
  if (data.type === 'disambiguation') return null;
  if (!data.extract) return null;
  return { bio: data.extract, image: data.thumbnail?.source ?? null, source: 'wikipedia' };
}

async function tryDiscogsImage(name: string): Promise<string | null> {
  const token = process.env.DISCOGS_TOKEN;
  if (!token) return null;
  const url = `https://api.discogs.com/database/search?q=${encodeURIComponent(name)}&type=artist&token=${token}`;
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': APP_UA } });
  if (!res.ok) return null;
  const data = (await res.json()) as { results?: { cover_image?: string; thumb?: string }[] };
  return data.results?.[0]?.cover_image || data.results?.[0]?.thumb || null;
}

export async function fetchArtistInfo(name: string): Promise<ArtistInfoResult | null> {
  let wiki: ArtistInfoResult | null = null;
  try {
    wiki = await tryWikipedia(name);
  } catch {
    // fall through
  }

  if (wiki?.image) return wiki;

  let discogsImage: string | null = null;
  try {
    discogsImage = await tryDiscogsImage(name);
  } catch {
    // fall through
  }

  if (wiki) return { ...wiki, image: discogsImage };
  if (discogsImage) return { bio: null, image: discogsImage, source: 'discogs' };
  return null;
}
