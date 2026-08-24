import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';

export default async function wikiRoutes(app: FastifyInstance) {
  app.get('/api/wiki', async () => {
    const items = db.prepare('SELECT id, title FROM wiki_articles ORDER BY title COLLATE NOCASE ASC').all();
    return { items };
  });

  app.get('/api/wiki/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const article = db.prepare('SELECT * FROM wiki_articles WHERE id = ?').get(id);
    if (!article) {
      reply.code(404);
      return { error: 'not found' };
    }
    return article;
  });
}
