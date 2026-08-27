import type { FastifyInstance } from 'fastify';
import { db, categoryName, releaseTypeName, type SqlParam } from '../db.js';
import { fetchCover } from '../cover.js';
import { fetchDiscogsExtras } from '../discogsRelease.js';

// Cover art / videos / Discogs links only make sense for music -- an
// e-book or application release has no "album art" or "Discogs release"
// to look up, and searching one up by name would just return noise.
const MUSIC_CATEGORY_ID = 1;

const PAGE_SIZE = 50;

// Counting the music releases costs ~3ms (covering index) and the answer
// never changes -- `releases` is a read-only archive, nothing in the app
// writes to it -- so it's worth exactly once per process rather than once
// per dice roll.
let cachedMusicReleaseCount: number | null = null;
function musicReleaseCount(): number {
  if (cachedMusicReleaseCount === null) {
    cachedMusicReleaseCount = (
      db.prepare('SELECT COUNT(*) AS n FROM releases WHERE category_id = ?').get(MUSIC_CATEGORY_ID) as { n: number }
    ).n;
  }
  return cachedMusicReleaseCount;
}

type SortKey = 'name_asc' | 'name_desc' | 'year_asc' | 'year_desc';

function sortClause(sort: string | undefined): string {
  switch (sort as SortKey) {
    case 'name_desc':
      return 'r.name COLLATE NOCASE DESC';
    case 'year_asc':
      return 'r.year ASC, r.name COLLATE NOCASE ASC';
    case 'year_desc':
      return 'r.year DESC, r.name COLLATE NOCASE ASC';
    case 'name_asc':
    default:
      return 'r.name COLLATE NOCASE ASC';
  }
}

function artistsForReleases(releaseIds: number[]) {
  if (releaseIds.length === 0) return new Map<number, { id: number; name: string; importance: number }[]>();
  const placeholders = releaseIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT ra.release_id, a.id, a.name, ra.importance
       FROM release_artists ra JOIN artists a ON a.id = ra.artist_id
       WHERE ra.release_id IN (${placeholders})
       ORDER BY ra.importance ASC, a.name COLLATE NOCASE ASC`,
    )
    .all(...releaseIds) as { release_id: number; id: number; name: string; importance: number }[];
  // A release can legitimately list the same artist twice with different
  // Importance (e.g. both "Main" and another role) -- dedupe by artist id,
  // keeping the first (lowest-importance, per the ORDER BY above) row.
  const map = new Map<number, { id: number; name: string; importance: number }[]>();
  const seen = new Map<number, Set<number>>();
  for (const row of rows) {
    const seenIds = seen.get(row.release_id) ?? new Set<number>();
    seen.set(row.release_id, seenIds);
    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id);
    const list = map.get(row.release_id) ?? [];
    list.push({ id: row.id, name: row.name, importance: row.importance });
    map.set(row.release_id, list);
  }
  return map;
}

export default async function torrentsRoutes(app: FastifyInstance) {
  app.get('/api/torrents/random', async () => {
    // A uniform offset into the same population ORDER BY RANDOM() drew
    // from -- identical distribution, without building a temp b-tree over
    // all ~1.08M music releases just to keep one row (measured 55ms ->
    // ~7ms). Deliberately NOT the random-id seek prewarmTick uses
    // (routes/tv.ts): release ids are severely clustered -- ~255k music
    // releases below id 2,000,000, nothing at all between 2M and 10M, and
    // ~826k above 70,000,000 -- so a seek would hand the row after each
    // gap a wildly outsized share of the picks. An offset can't skew.
    const row = db
      .prepare('SELECT id FROM releases WHERE category_id = ? LIMIT 1 OFFSET ?')
      .get(MUSIC_CATEGORY_ID, Math.floor(Math.random() * musicReleaseCount())) as { id: number };
    return { id: row.id };
  });

  app.get('/api/torrents', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(1, Number(q.page) || 1);
    const categories = (q.category ?? '')
      .split(',')
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0);
    const tagId = q.tag ? Number(q.tag) : undefined;
    const releaseType = q.type ? Number(q.type) : undefined;
    const search = (q.q ?? '').trim();

    const where: string[] = [];
    const params: SqlParam[] = [];

    if (categories.length > 0) {
      where.push(`r.category_id IN (${categories.map(() => '?').join(',')})`);
      params.push(...categories);
    }
    if (releaseType) {
      where.push('r.release_type = ?');
      params.push(releaseType);
    }
    // Driving a tag filter from `releases` with an EXISTS subquery makes
    // SQLite SCAN all ~1.22M rows and run the (indexed, but per-row) check
    // against every one -- confirmed with EXPLAIN QUERY PLAN, and it cost
    // the same whether the tag matched 500,000 releases or none at all
    // (a tag with zero matches still took 0.46s). Since node:sqlite is
    // synchronous, that is ~2s of the single JS thread blocked for every
    // other visitor too, twice per request (COUNT + rows). release_tags
    // has an index on tag_id, so driving from there turns "scan a million
    // releases" into "look up this tag's rows": 1.58s -> 0.05s for the
    // rows, 0.46s -> 0.003s for the count. Same fix routes/tv.ts already
    // applies to its own tag filter.
    //
    // Only when there's no text search, though -- a search already drives
    // from releases_fts, and it narrows to a small set first ('love*' ->
    // 19k rows in 14ms), so the per-row EXISTS check is cheap on top of
    // that. Two drivers can't both be the FROM clause.
    //
    // No DISTINCT needed (unlike tv.ts, which matches several tags at
    // once): only one tag is ever filtered here and release_tags' primary
    // key is (release_id, tag_id), so a release can't appear twice.
    const tagDrivesQuery = tagId !== undefined && !search;

    if (tagId) {
      where.push(
        tagDrivesQuery
          ? 'rtf.tag_id = ?'
          : 'EXISTS (SELECT 1 FROM release_tags rt WHERE rt.release_id = r.id AND rt.tag_id = ?)',
      );
      params.push(tagId);
    }
    let fromClause = 'FROM releases r';
    if (tagDrivesQuery) {
      // The JOIN back to releases is load-bearing, not decoration:
      // release_tags holds rows for releases that aren't in this dump at
      // all (3,123 of them for tag 50 alone), so counting release_tags
      // directly would inflate every total.
      fromClause = 'FROM release_tags rtf JOIN releases r ON r.id = rtf.release_id';
    } else if (search) {
      fromClause = 'FROM releases_fts f JOIN releases r ON r.id = f.rowid';
      where.push('f.name MATCH ?');
      params.push(search.split(/\s+/).map((t) => `${t}*`).join(' '));
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      db.prepare(`SELECT COUNT(*) AS n ${fromClause} ${whereClause}`).get(...params) as { n: number }
    ).n;

    // So the frontend can show *what* is being browsed (e.g. a "Tag: indie"
    // header) instead of a filtered list that looks identical to the
    // unfiltered one.
    const activeTag = tagId
      ? (db.prepare('SELECT id, name FROM tags WHERE id = ?').get(tagId) as { id: number; name: string } | undefined)
      : undefined;

    const rows = db
      .prepare(
        `SELECT r.id, r.name, r.year, r.category_id, r.release_type
         ${fromClause} ${whereClause}
         ORDER BY ${sortClause(q.sort)}
         LIMIT ? OFFSET ?`,
      )
      .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE) as {
      id: number;
      name: string;
      year: number;
      category_id: number;
      release_type: number;
    }[];

    const artistMap = artistsForReleases(rows.map((r) => r.id));

    return {
      page,
      pageSize: PAGE_SIZE,
      total,
      activeTag: activeTag ?? null,
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        year: r.year || null,
        categoryId: r.category_id,
        categoryName: categoryName(r.category_id),
        releaseType: releaseTypeName(r.release_type),
        artists: artistMap.get(r.id) ?? [],
      })),
    };
  });

  app.get('/api/torrents/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const release = db.prepare('SELECT * FROM releases WHERE id = ?').get(id) as
      | {
          id: number;
          category_id: number;
          name: string;
          year: number;
          catalogue_number: string;
          record_label: string;
          release_type: number;
          time: string | null;
        }
      | undefined;
    if (!release) {
      reply.code(404);
      return { error: 'not found' };
    }

    const artists = artistsForReleases([id]).get(id) ?? [];

    const tags = db
      .prepare(
        `SELECT t.id, t.name FROM release_tags rt JOIN tags t ON t.id = rt.tag_id
         WHERE rt.release_id = ? ORDER BY rt.positive_votes DESC`,
      )
      .all(id) as { id: number; name: string }[];

    // what.tv renders only the header fields below -- no editions table,
    // no collage list -- but re-fetches this route on every "Next", and
    // auto-advances forever once a video ends. summary mode lets it skip
    // two queries and the payload they carry, without a second release
    // endpoint that could drift out of sync with this one.
    const summary = (req.query as { fields?: string }).fields === 'summary';

    // file_list is deliberately absent: it is 2.3GB across the table (58%
    // of the whole database) and the release page only reveals it behind a
    // collapsed "View file list" toggle, yet every response carried it.
    // One release ran to 3.70MB of JSON of which 3.2KB was everything
    // *except* the file lists -- serialized on the one JS thread, blocking
    // every other visitor. GET /api/torrents/:id/files serves it on demand
    // instead. `time` is dropped for the same reason on a smaller scale:
    // 61MB of column that no view has ever rendered.
    const editions = summary
      ? []
      : db
          .prepare(
            `SELECT id, media, format, encoding, remastered, remaster_year, remaster_title,
                    remaster_catalogue_number, remaster_record_label, scene, has_log, has_cue,
                    log_score, size
             FROM torrents WHERE release_id = ? ORDER BY remaster_year ASC, format ASC`,
          )
          .all(id);

    const collages = summary
      ? []
      : db
          .prepare(
            `SELECT c.id, c.name, c.num_torrents FROM collage_releases cr JOIN collages c ON c.id = cr.collage_id
             WHERE cr.release_id = ? ORDER BY c.name COLLATE NOCASE ASC`,
          )
          .all(id);

    return {
      id: release.id,
      name: release.name,
      year: release.year || null,
      categoryId: release.category_id,
      categoryName: categoryName(release.category_id),
      catalogueNumber: release.catalogue_number || null,
      recordLabel: release.record_label || null,
      releaseType: releaseTypeName(release.release_type),
      artists,
      tags,
      editions,
      collages,
    };
  });

  // Fetched only when a visitor actually opens an edition's "View file
  // list" toggle (see web/src/pages/TorrentGroup.tsx). Keyed by torrent id
  // so the page can cache each list it has already opened. Raw Gazelle
  // FileList text -- web/src/lib/fileList.ts parses it.
  app.get('/api/torrents/:id/files', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      reply.code(400);
      return { error: 'invalid id' };
    }
    const rows = db.prepare('SELECT id, file_list FROM torrents WHERE release_id = ?').all(id) as {
      id: number;
      file_list: string | null;
    }[];
    const files: Record<number, string> = {};
    for (const row of rows) files[row.id] = row.file_list ?? '';
    return { files };
  });

  app.get('/api/torrents/:id/cover', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);

    const cached = db.prepare('SELECT cover_url, source FROM release_covers WHERE release_id = ?').get(id) as
      | { cover_url: string | null; source: string | null }
      | undefined;
    if (cached) {
      return cached.cover_url ? { url: cached.cover_url, source: cached.source } : { url: null };
    }

    const release = db.prepare('SELECT name, category_id FROM releases WHERE id = ?').get(id) as
      | { name: string; category_id: number }
      | undefined;
    if (!release) {
      reply.code(404);
      return { error: 'not found' };
    }
    if (release.category_id !== MUSIC_CATEGORY_ID) {
      return { url: null };
    }
    const primaryArtist = db
      .prepare(
        `SELECT a.name FROM release_artists ra JOIN artists a ON a.id = ra.artist_id
         WHERE ra.release_id = ? AND ra.importance = 1 ORDER BY a.name LIMIT 1`,
      )
      .get(id) as { name: string } | undefined;

    const result = await fetchCover(primaryArtist?.name ?? '', release.name);

    db.prepare(
      'INSERT OR REPLACE INTO release_covers (release_id, cover_url, source, fetched_at) VALUES (?, ?, ?, ?)',
    ).run(id, result?.url ?? null, result?.source ?? null, new Date().toISOString());

    return result ? { url: result.url, source: result.source } : { url: null };
  });

  // Live-fetches Discogs extras for a release and caches the result,
  // unconditionally -- callers decide whether a cache hit should skip this
  // (the plain GET route below) or force it (the refresh route).
  async function fetchAndCacheExtras(id: number, reply: { code: (n: number) => void }) {
    const release = db.prepare('SELECT name, category_id FROM releases WHERE id = ?').get(id) as
      | { name: string; category_id: number }
      | undefined;
    if (!release) {
      reply.code(404);
      return { error: 'not found' };
    }
    if (release.category_id !== MUSIC_CATEGORY_ID) {
      return { discogsUrl: null, videos: [] };
    }
    const primaryArtist = db
      .prepare(
        `SELECT a.name FROM release_artists ra JOIN artists a ON a.id = ra.artist_id
         WHERE ra.release_id = ? AND ra.importance = 1 ORDER BY a.name LIMIT 1`,
      )
      .get(id) as { name: string } | undefined;

    const result = await fetchDiscogsExtras(primaryArtist?.name ?? '', release.name).catch(() => null);

    db.prepare(
      'INSERT OR REPLACE INTO release_extras (release_id, discogs_url, videos, fetched_at) VALUES (?, ?, ?, ?)',
    ).run(id, result?.discogsUrl ?? null, result ? JSON.stringify(result.videos) : null, new Date().toISOString());

    // fetchDiscogsExtras coming back empty means it couldn't verify any of
    // Discogs' search results as the actual release (see discogsRelease.ts)
    // -- the same blind "take the first search hit" flaw that bug fixed
    // also exists in cover.ts's tryDiscogs, uncorrected, so a cover cached
    // from Discogs for this release was very likely pulled from that same
    // wrong record. Clearing it lets the next /cover lookup try again
    // (iTunes first) instead of keeping a probably-wrong image forever.
    if (!result) {
      db.prepare("DELETE FROM release_covers WHERE release_id = ? AND source = 'discogs'").run(id);
    }

    return { discogsUrl: result?.discogsUrl ?? null, videos: result?.videos ?? [] };
  }

  app.get('/api/torrents/:id/extras', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);

    const cached = db.prepare('SELECT discogs_url, videos FROM release_extras WHERE release_id = ?').get(id) as
      | { discogs_url: string | null; videos: string | null }
      | undefined;
    if (cached) {
      return {
        discogsUrl: cached.discogs_url,
        videos: cached.videos ? (JSON.parse(cached.videos) as { url: string; title: string }[]) : [],
      };
    }

    return fetchAndCacheExtras(id, reply);
  });

  // Below this, a repeat refresh on the same release within the cooldown
  // is a no-op against Discogs -- nothing there could plausibly have
  // changed in that window, so it isn't worth a turn in the shared queue.
  const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

  // Manual re-check: a visitor who just added a video on Discogs has no
  // other way to see it here, since the GET route above caches permanently
  // (see CLAUDE.md's "DB-first, always" external-lookup rule -- correct for
  // a closed, unchanging whatcd catalogue, but Discogs' own side keeps
  // changing). On-demand only, never automatic, so it can't reintroduce the
  // kind of continuous live-lookup traffic that what.tv's old pre-warmer
  // was removed for.
  //
  // Unlike the GET route, this is an unauthenticated action anyone can fire
  // for any release id at will -- and every hit funnels through the single
  // process-wide Discogs throttle queue (discogsThrottle.ts), so a burst of
  // refreshes (mashed clicks, a bot) would back up every other live Discogs
  // lookup sitewide, not just cost this one request time. The cooldown
  // below bounds that: repeat refreshes on the same release within it are
  // answered from cache instead of taking another turn in the queue.
  app.post('/api/torrents/:id/extras/refresh', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);

    const cached = db.prepare('SELECT discogs_url, videos, fetched_at FROM release_extras WHERE release_id = ?').get(id) as
      | { discogs_url: string | null; videos: string | null; fetched_at: string | null }
      | undefined;
    if (cached?.fetched_at && Date.now() - new Date(cached.fetched_at).getTime() < REFRESH_COOLDOWN_MS) {
      return {
        discogsUrl: cached.discogs_url,
        videos: cached.videos ? (JSON.parse(cached.videos) as { url: string; title: string }[]) : [],
      };
    }

    return fetchAndCacheExtras(id, reply);
  });
}
