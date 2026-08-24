import type { FastifyInstance } from 'fastify';
import { db, categoryName, releaseTypeName } from '../db.js';
import { fetchArtistInfo } from '../artistInfo.js';

export default async function artistsRoutes(app: FastifyInstance) {
  // No full artist directory (1.4M+ names, and the real site never had one
  // either) -- search-driven access only.
  app.get('/api/artists/search', async (req) => {
    const q = ((req.query as { q?: string }).q ?? '').trim();
    if (q.length < 2) return { items: [] };
    const rows = db
      .prepare(
        `SELECT a.id, a.name FROM artists_fts f JOIN artists a ON a.id = f.rowid
         WHERE f.name MATCH ? ORDER BY length(a.name) ASC LIMIT 25`,
      )
      .all(`${q}*`) as { id: number; name: string }[];
    return { items: rows };
  });

  app.get('/api/artists/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(id) as
      | { id: number; name: string }
      | undefined;
    if (!artist) {
      reply.code(404);
      return { error: 'not found' };
    }

    const aliases = db
      .prepare('SELECT id, name FROM artist_aliases WHERE artist_id = ? AND redirect = 0')
      .all(id) as { id: number; name: string }[];

    const releaseRows = db
      .prepare(
        `SELECT r.id, r.name, r.year, r.category_id, r.release_type, ra.importance
         FROM release_artists ra JOIN releases r ON r.id = ra.release_id
         WHERE ra.artist_id = ?
         ORDER BY r.year ASC, r.name COLLATE NOCASE ASC`,
      )
      .all(id) as {
      id: number;
      name: string;
      year: number;
      category_id: number;
      release_type: number;
      importance: number;
    }[];

    const releases = releaseRows.map((r) => ({
      id: r.id,
      name: r.name,
      year: r.year || null,
      categoryId: r.category_id,
      categoryName: categoryName(r.category_id),
      releaseType: releaseTypeName(r.release_type),
      importance: r.importance,
    }));

    // Discography grouped the way artist.php does: primary-artist releases
    // (Importance 1) bucketed by release type, everything else ("guest
    // appearances", importance > 1) in its own group.
    const groups: Record<string, typeof releases> = {};
    const appearsOn: typeof releases = [];
    for (const r of releases) {
      if (r.importance === 1) {
        (groups[r.releaseType] ??= []).push(r);
      } else {
        appearsOn.push(r);
      }
    }

    // artists_similar's SimilarID isn't an artist id -- it's a shared id
    // for one *pair* relationship (two rows, one per artist in the pair,
    // sharing a SimilarID), same model the real ARTISTS_SIMILAR class
    // uses. Self-join to find the other artist in each pair this artist
    // is part of, ranked by that pair's vote score.
    const similarArtists = db
      .prepare(
        `SELECT a.id, a.name, ass.score
         FROM artists_similar s1
         JOIN artists_similar s2 ON s2.similar_id = s1.similar_id AND s2.artist_id != s1.artist_id
         JOIN artists a ON a.id = s2.artist_id
         LEFT JOIN artists_similar_scores ass ON ass.similar_id = s1.similar_id
         WHERE s1.artist_id = ?
         ORDER BY ass.score DESC
         LIMIT 20`,
      )
      .all(id) as { id: number; name: string; score: number | null }[];

    return {
      id: artist.id,
      name: artist.name,
      aliases,
      discography: groups,
      appearsOn,
      similarArtists,
    };
  });

  app.get('/api/artists/:id/info', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);

    const cached = db.prepare('SELECT bio, image_url, source FROM artist_info WHERE artist_id = ?').get(id) as
      | { bio: string | null; image_url: string | null; source: string | null }
      | undefined;
    if (cached) {
      return { bio: cached.bio, image: cached.image_url, source: cached.source };
    }

    const artist = db.prepare('SELECT name FROM artists WHERE id = ?').get(id) as { name: string } | undefined;
    if (!artist) {
      reply.code(404);
      return { error: 'not found' };
    }

    // Photo/bio lookup is music-only -- an artist whose only credits are
    // e-books/apps/etc. isn't a "musical artist" Wikipedia would even
    // have a page for, and searching one up by name would just add noise.
    const hasMusicRelease = db
      .prepare(
        `SELECT 1 FROM release_artists ra JOIN releases r ON r.id = ra.release_id
         WHERE ra.artist_id = ? AND r.category_id = 1 LIMIT 1`,
      )
      .get(id);
    if (!hasMusicRelease) {
      return { bio: null, image: null, source: null };
    }

    const result = await fetchArtistInfo(artist.name);

    db.prepare(
      'INSERT OR REPLACE INTO artist_info (artist_id, bio, image_url, source, fetched_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, result?.bio ?? null, result?.image ?? null, result?.source ?? null, new Date().toISOString());

    return { bio: result?.bio ?? null, image: result?.image ?? null, source: result?.source ?? null };
  });
}
