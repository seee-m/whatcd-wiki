import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import torrentsRoutes from './routes/torrents.js';
import artistsRoutes from './routes/artists.js';
import collagesRoutes from './routes/collages.js';
import tagsRoutes from './routes/tags.js';
import wikiRoutes from './routes/wiki.js';
import listsRoutes from './routes/lists.js';
import visitorsRoutes from './routes/visitors.js';
import tvRoutes, { startTvPrewarm } from './routes/tv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DISCOGS_TOKEN (cover art fallback) lives in api/.env, gitignored.
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

const PORT = Number(process.env.PORT) || 4000;

const app = Fastify({ logger: true });

await app.register(torrentsRoutes);
await app.register(artistsRoutes);
await app.register(collagesRoutes);
await app.register(tagsRoutes);
await app.register(wikiRoutes);
await app.register(listsRoutes);
await app.register(visitorsRoutes);
await app.register(tvRoutes);
startTvPrewarm();

// In production this process also serves the built React app (web/dist),
// so the deployed unit is one Node process + one SQLite file -- see the
// "Hosting readiness" section of the plan.
const webDist = path.join(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith('/api/')) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    reply.sendFile('index.html');
  });
}

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
