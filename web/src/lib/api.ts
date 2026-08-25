export interface ArtistRef {
  id: number;
  name: string;
  importance?: number;
}

export interface Category {
  id: number;
  name: string;
  icon: string;
}

export interface ReleaseType {
  id: number;
  name: string;
}

export interface ReleaseListItem {
  id: number;
  name: string;
  year: number | null;
  categoryId: number;
  categoryName: string;
  releaseType: string;
  artists: ArtistRef[];
}

export interface ReleaseList {
  page: number;
  pageSize: number;
  total: number;
  activeTag: { id: number; name: string } | null;
  items: ReleaseListItem[];
}

export interface TorrentEdition {
  id: number;
  media: string | null;
  format: string | null;
  encoding: string | null;
  remastered: number;
  remaster_year: number | null;
  remaster_title: string | null;
  remaster_catalogue_number: string | null;
  remaster_record_label: string | null;
  scene: number;
  has_log: number;
  has_cue: number;
  log_score: number;
  file_list: string;
  size: number;
  time: string | null;
}

export interface ReleaseDetail {
  id: number;
  name: string;
  year: number | null;
  categoryId: number;
  categoryName: string;
  catalogueNumber: string | null;
  recordLabel: string | null;
  releaseType: string;
  artists: ArtistRef[];
  tags: { id: number; name: string }[];
  editions: TorrentEdition[];
  collages: { id: number; name: string; num_torrents: number }[];
}

export interface ArtistDetail {
  id: number;
  name: string;
  aliases: { id: number; name: string }[];
  discography: Record<string, ReleaseListItem[]>;
  appearsOn: ReleaseListItem[];
  similarArtists: { id: number; name: string; score: number | null }[];
}

export interface ArtistInfo {
  bio: string | null;
  image: string | null;
  source: string | null;
}

export interface ReleaseExtras {
  discogsUrl: string | null;
  videos: { url: string; title: string }[];
}

export interface CollageListItem {
  id: number;
  name: string;
  numTorrents: number;
  categoryId: number;
  categoryName: string;
  subscribers: number;
}

export interface CollageList {
  page: number;
  pageSize: number;
  total: number;
  items: CollageListItem[];
}

export interface CollageDetail {
  id: number;
  name: string;
  categoryId: number;
  categoryName: string;
  tags: { id: number | null; name: string }[];
  subscribers: number;
  numTorrents: number;
  artistCount: number;
  updated: string | null;
  releases: { id: number; name: string; year: number | null; artists: ArtistRef[] }[];
}

export interface TagListItem {
  id: number;
  name: string;
  tag_type: string;
  uses: number;
}

export interface WikiIndexItem {
  id: number;
  title: string;
}

export interface WikiArticle {
  id: number;
  title: string;
  date: string | null;
  body_html: string;
}

export interface SharedList {
  id: string;
  title: string;
  description: string | null;
  categoryId: number;
  categoryName: string;
  createdAt: string;
  releases: { id: number; name: string; year: number | null; artists: ArtistRef[] }[];
}

export interface CreateListRequest {
  title: string;
  description?: string;
  categoryId?: number;
  releaseIds: number[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  categories: () => get<Category[]>('/api/categories'),
  releaseTypes: () => get<ReleaseType[]>('/api/release-types'),
  torrents: (params: URLSearchParams) => get<ReleaseList>(`/api/torrents?${params}`),
  randomTorrent: () => get<{ id: number }>('/api/torrents/random'),
  torrent: (id: number | string) => get<ReleaseDetail>(`/api/torrents/${id}`),
  // Not plain `get()` -- a "no matches" 404 carries a human-readable
  // `error` message (see api/src/routes/tv.ts) that what.tv surfaces
  // directly to the user instead of a generic "404" failure.
  tvRandom: async (params: URLSearchParams) => {
    const res = await fetch(`/api/tv/random?${params}`);
    const data = (await res.json().catch(() => null)) as
      | { id: number; poolHealthy: boolean; poolThreshold: number; error?: string }
      | null;
    if (!res.ok) {
      throw new Error(data?.error ?? `tv/random -> ${res.status}`);
    }
    return data as { id: number; poolHealthy: boolean; poolThreshold: number };
  },
  // Fire-and-forget from the player's onError (see pages/TvPlay.tsx) --
  // prunes a rotted video link out of the shared release_extras cache so
  // it's never served again, for this release or anyone else's.
  tvReportDeadVideo: (id: number | string, url: string) => post<{ removed: boolean }>(`/api/tv/${id}/video-dead`, { url }),
  torrentCover: (id: number | string) => get<{ url: string | null; source?: string }>(`/api/torrents/${id}/cover`),
  torrentExtras: (id: number | string) => get<ReleaseExtras>(`/api/torrents/${id}/extras`),
  artistSearch: (q: string) => get<{ items: ArtistRef[] }>(`/api/artists/search?q=${encodeURIComponent(q)}`),
  artist: (id: number | string) => get<ArtistDetail>(`/api/artists/${id}`),
  artistInfo: (id: number | string) => get<ArtistInfo>(`/api/artists/${id}/info`),
  collages: (params: URLSearchParams) => get<CollageList>(`/api/collages?${params}`),
  collageCategories: () => get<{ id: number; name: string }[]>('/api/collage-categories'),
  collage: (id: number | string) => get<CollageDetail>(`/api/collages/${id}`),
  tags: (params: URLSearchParams) => get<{ page: number; pageSize: number; total: number; items: TagListItem[] }>(
    `/api/tags?${params}`,
  ),
  wikiIndex: () => get<{ items: WikiIndexItem[] }>('/api/wiki'),
  wikiArticle: (id: number | string) => get<WikiArticle>(`/api/wiki/${id}`),
  createList: (body: CreateListRequest) => post<{ id: string }>('/api/lists', body),
  list: (id: string) => get<SharedList>(`/api/lists/${id}`),
  visitorsToday: () => get<{ count: number }>('/api/visitors-today'),
};
