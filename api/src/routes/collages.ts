import type { FastifyInstance } from 'fastify';
import { db, collageCategoryName, type SqlParam } from '../db.js';

// collages.tag_list is denormalized text using the same dot-separated word
// convention as the canonical tags.name column (e.g. "hip.hop",
// "avant.garde") -- resolve each raw token against tags to find its real
// id (so it can link to /torrents?tag=id, same as release tags), and only
// convert dots to spaces for the *display* label.
function resolveTagList(db: import('node:sqlite').DatabaseSync, tagList: string): { id: number | null; name: string }[] {
  if (!tagList) return [];
  const tokens = [...new Set(tagList.split(/\s+/).filter(Boolean))];
  if (tokens.length === 0) return [];
  const placeholders = tokens.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, name FROM tags WHERE name IN (${placeholders})`).all(...tokens) as {
    id: number;
    name: string;
  }[];
  const byName = new Map(rows.map((r) => [r.name, r.id]));
  return tokens.map((t) => ({ id: byName.get(t) ?? null, name: t.replace(/[._]/g, ' ') }));
}

const PAGE_SIZE = 50;

export default async function collagesRoutes(app: FastifyInstance) {
  app.get('/api/collages', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(1, Number(q.page) || 1);
    const search = (q.q ?? '').trim();
    const sort = q.sort === 'name_desc' ? 'c.name COLLATE NOCASE DESC' : 'c.name COLLATE NOCASE ASC';

    let fromClause = 'FROM collages c';
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (search) {
      fromClause = 'FROM collages_fts f JOIN collages c ON c.id = f.rowid';
      where.push('f.name MATCH ?');
      params.push(search.split(/\s+/).map((t) => `${t}*`).join(' '));
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (
      db.prepare(`SELECT COUNT(*) AS n ${fromClause} ${whereClause}`).get(...params) as { n: number }
    ).n;
    const items = db
      .prepare(
        `SELECT c.id, c.name, c.num_torrents, c.category_id, c.subscribers
         ${fromClause} ${whereClause} ORDER BY ${sort} LIMIT ? OFFSET ?`,
      )
      .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE) as {
      id: number;
      name: string;
      num_torrents: number;
      category_id: number;
      subscribers: number;
    }[];

    return {
      page,
      pageSize: PAGE_SIZE,
      total,
      items: items.map((c) => ({
        id: c.id,
        name: c.name,
        numTorrents: c.num_torrents,
        categoryId: c.category_id,
        categoryName: collageCategoryName(c.category_id),
        subscribers: c.subscribers,
      })),
    };
  });

  app.get('/api/collages/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const collage = db.prepare('SELECT * FROM collages WHERE id = ?').get(id) as
      | {
          id: number;
          name: string;
          num_torrents: number;
          category_id: number;
          tag_list: string;
          subscribers: number;
          updated: string | null;
        }
      | undefined;
    if (!collage) {
      reply.code(404);
      return { error: 'not found' };
    }

    const artistCount = (
      db
        .prepare(
          `SELECT COUNT(DISTINCT ra.artist_id) AS n FROM release_artists ra
           JOIN collage_releases cr ON cr.release_id = ra.release_id
           WHERE cr.collage_id = ?`,
        )
        .get(id) as { n: number }
    ).n;

    const releaseRows = db
      .prepare(
        `SELECT r.id, r.name, r.year, r.category_id
         FROM collage_releases cr JOIN releases r ON r.id = cr.release_id
         WHERE cr.collage_id = ? ORDER BY cr.sort ASC`,
      )
      .all(id) as { id: number; name: string; year: number; category_id: number }[];

    const releaseIds = releaseRows.map((r) => r.id);
    const artistMap = new Map<number, { id: number; name: string }[]>();
    if (releaseIds.length) {
      const placeholders = releaseIds.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT ra.release_id, a.id, a.name FROM release_artists ra JOIN artists a ON a.id = ra.artist_id
           WHERE ra.release_id IN (${placeholders}) AND ra.importance = 1
           ORDER BY a.name COLLATE NOCASE ASC`,
        )
        .all(...releaseIds) as { release_id: number; id: number; name: string }[];
      for (const row of rows) {
        const list = artistMap.get(row.release_id) ?? [];
        list.push({ id: row.id, name: row.name });
        artistMap.set(row.release_id, list);
      }
    }

    return {
      id: collage.id,
      name: collage.name,
      categoryId: collage.category_id,
      categoryName: collageCategoryName(collage.category_id),
      tags: resolveTagList(db, collage.tag_list),
      subscribers: collage.subscribers,
      numTorrents: collage.num_torrents,
      artistCount,
      updated: collage.updated,
      releases: releaseRows.map((r) => ({
        id: r.id,
        name: r.name,
        year: r.year || null,
        artists: artistMap.get(r.id) ?? [],
      })),
    };
  });
}
