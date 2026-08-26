import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCompress from '@fastify/compress';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import torrentsRoutes from './routes/torrents.js';
import artistsRoutes from './routes/artists.js';
import collagesRoutes from './routes/collages.js';
import tagsRoutes from './routes/tags.js';
import wikiRoutes from './routes/wiki.js';
import listsRoutes from './routes/lists.js';
import visitorsRoutes from './routes/visitors.js';
import tvRoutes from './routes/tv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DISCOGS_TOKEN (cover art fallback) lives in api/.env, gitignored.
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

const PORT = Number(process.env.PORT) || 4000;

const app = Fastify({ logger: true });

// Nothing was compressing anything: Fly's proxy doesn't, and Fastify
// doesn't by default, so every JSON response and the whole JS bundle went
// out raw. Measured: bundle 244KB -> 84KB, stylesheet 24KB -> 6KB, a
// browse page's JSON 4.0KB -> 1.0KB, a large collage 597KB -> 166KB.
// Registered before the routes so it covers the API and web/dist alike.
await app.register(fastifyCompress, { global: true, encodings: ['br', 'gzip', 'deflate'] });

await app.register(torrentsRoutes);
await app.register(artistsRoutes);
await app.register(collagesRoutes);
await app.register(tagsRoutes);
await app.register(wikiRoutes);
await app.register(listsRoutes);
await app.register(visitorsRoutes);
await app.register(tvRoutes);

// In production this process also serves the built React app (web/dist),
// so the deployed unit is one Node process + one SQLite file -- see the
// "Hosting readiness" section of the plan.
const webDist = path.join(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  // Vite content-hashes everything under /assets, so those filenames only
  // ever refer to one build and can be cached hard. index.html must not
  // be -- it's what points at the current hashed filenames, and a stale
  // copy would pin a visitor to a previous deploy.
  await app.register(fastifyStatic, {
    root: webDist,
    // The plugin sets its own `public, max-age=0` unless this is off, and
    // it wins over setHeaders -- leaving it on silently discards the
    // headers below.
    cacheControl: false,
    setHeaders(res, filePath) {
      if (filePath.includes('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith('/api/')) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    reply.sendFile('index.html');
  });
}

// Fly stops machines with SIGTERM on every deploy. The database is
// crash-safe without this -- SQLite replays the WAL on next open -- but
// folding it back into the main file first means a deploy never starts by
// replaying one. db.close() alone does NOT do this: checked, and it leaves
// the WAL at full size, so the checkpoint has to be explicit. (The -wal and
// -shm files themselves stay on disk either way; TRUNCATE takes the WAL to
// zero bytes, which is the part that matters.)
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.close().then(
      () => {
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          db.close();
        } catch {
          // Shutting down anyway -- a failed checkpoint just means the next
          // boot replays the WAL, which is the normal recovery path.
        }
        process.exit(0);
      },
      () => process.exit(1),
    );
  });
}

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
