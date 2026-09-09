import type { FastifyInstance } from 'fastify';
import { BUILD_NUMBER } from '../buildNumber.js';

export default async function buildRoutes(app: FastifyInstance) {
  app.get('/api/build', async () => {
    return { build: BUILD_NUMBER };
  });
}
