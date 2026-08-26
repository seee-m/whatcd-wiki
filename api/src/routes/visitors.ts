import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { BUILD_NUMBER } from '../buildNumber.js';

export default async function visitorsRoutes(app: FastifyInstance) {
  // Also carries the build number -- the footer needs both on every page
  // load, so riding along on the same request avoids a second round trip.
  app.get('/api/visitor-count', async () => {
    db.prepare('UPDATE site_visits SET count = count + 1 WHERE id = 1').run();
    const row = db.prepare('SELECT count FROM site_visits WHERE id = 1').get() as { count: number };
    return { count: row.count, build: BUILD_NUMBER };
  });
}
