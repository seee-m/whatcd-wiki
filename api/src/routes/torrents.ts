import type { FastifyInstance } from 'fastify';
import { db, CATEGORIES, categoryName, RELEASE_TYPES, releaseTypeName, type SqlParam } from '../db.js';
import { fetchCover } from '../cover.js';
import { fetchDiscogsExtras } from '../discogsRelease.js';

// Cover art / videos / Discogs links only make sense for music -- an
// e-book or application release has no "album art" or "Discogs release"
// to look up, and searching one up by name would just return noise.
const MUSIC_CATEGORY_ID = 1;

const PAGE_SIZE = 50;

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
  app.get('/api/categories', async () => CATEGORIES);
  app.get('/api/release-types', async () =>
    Object.entries(RELEASE_TYPES).map(([id, name]) => ({ id: Number(id), name })),
  );

  app.get('/api/torrents/random', async () => {
    const row = db
      .prepare('SELECT id FROM releases WHERE category_id = ? ORDER BY RANDOM() LIMIT 1')
      .get(MUSIC_CATEGORY_ID) as { id: number };
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
    if (tagId) {
      where.push('EXISTS (SELECT 1 FROM release_tags rt WHERE rt.release_id = r.id AND rt.tag_id = ?)');
      params.push(tagId);
    }
    let fromClause = 'FROM releases r';
    if (search) {
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

    const editions = db
      .prepare(
        `SELECT id, media, format, encoding, remastered, remaster_year, remaster_title,
                remaster_catalogue_number, remaster_record_label, scene, has_log, has_cue,
                log_score, file_list, size, time
         FROM torrents WHERE release_id = ? ORDER BY remaster_year ASC, format ASC`,
      )
      .all(id);

    const collages = db
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

    return { discogsUrl: result?.discogsUrl ?? null, videos: result?.videos ?? [] };
  });
}
