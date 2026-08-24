import type { FastifyInstance } from 'fastify';
import { db, type SqlParam } from '../db.js';

const PAGE_SIZE = 100;

export default async function tagsRoutes(app: FastifyInstance) {
  app.get('/api/tags', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(1, Number(q.page) || 1);
    const search = (q.q ?? '').trim();
    const tagType = q.type === 'genre' || q.type === 'other' ? q.type : undefined;
    const sort = q.sort === 'name_desc' ? 'name COLLATE NOCASE DESC' : q.sort === 'uses' ? 'uses DESC' : 'name COLLATE NOCASE ASC';

    let fromClause = 'FROM tags t';
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (search) {
      fromClause = 'FROM tags_fts f JOIN tags t ON t.id = f.rowid';
      where.push('f.name MATCH ?');
      params.push(`${search}*`);
    }
    if (tagType) {
      where.push('t.tag_type = ?');
      params.push(tagType);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (
      db.prepare(`SELECT COUNT(*) AS n ${fromClause} ${whereClause}`).get(...params) as { n: number }
    ).n;
    const items = db
      .prepare(`SELECT t.id, t.name, t.tag_type, t.uses ${fromClause} ${whereClause} ORDER BY t.${sort} LIMIT ? OFFSET ?`)
      .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);

    return { page, pageSize: PAGE_SIZE, total, items };
  });
}
