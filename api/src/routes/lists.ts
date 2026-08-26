import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { db, COLLAGE_CATEGORIES, collageCategoryName, type SqlParam } from '../db.js';

const MAX_RELEASES_PER_LIST = 300;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1000;

// Simple in-memory per-IP rate limit on list creation, not reads -- fine on
// a single always-on Fly machine (no distributed state needed), and cheap
// insurance against the table growing from casual abuse/bots without
// pulling in a dependency for it. Fly's proxy sets fly-client-ip with the
// real client address; req.ip alone would be Fly's internal proxy address.
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 20;
const createTimestamps = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (createTimestamps.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  createTimestamps.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}

function generateId(): string {
  return crypto.randomBytes(6).toString('base64url');
}

export default async function listsRoutes(app: FastifyInstance) {
  app.post('/api/lists', async (req, reply) => {
    const ip = (req.headers['fly-client-ip'] as string | undefined) ?? req.ip;
    if (isRateLimited(ip)) {
      reply.code(429);
      return { error: 'too many lists created, try again later' };
    }

    const body = req.body as { title?: unknown; description?: unknown; categoryId?: unknown; releaseIds?: unknown };

    const title = typeof body.title === 'string' ? body.title.trim().slice(0, MAX_TITLE_LENGTH) : '';
    if (!title) {
      reply.code(400);
      return { error: 'title is required' };
    }

    const description =
      typeof body.description === 'string' && body.description.trim()
        ? body.description.trim().slice(0, MAX_DESCRIPTION_LENGTH)
        : null;

    const categoryId =
      typeof body.categoryId === 'number' && body.categoryId in COLLAGE_CATEGORIES ? body.categoryId : 0;

    const rawIds = Array.isArray(body.releaseIds) ? body.releaseIds : [];
    const dedupedIds = [...new Set(rawIds.filter((n): n is number => Number.isInteger(n) && n > 0))].slice(
      0,
      MAX_RELEASES_PER_LIST,
    );
    if (dedupedIds.length === 0) {
      reply.code(400);
      return { error: 'releaseIds must be a non-empty array of release ids' };
    }

    // Silently drop any ids that don't actually exist rather than erroring
    // -- keeps a stale/bogus id from failing the whole request, at the cost
    // of one cheap indexed lookup.
    const placeholders = dedupedIds.map(() => '?').join(',');
    const existingRows = db.prepare(`SELECT id FROM releases WHERE id IN (${placeholders})`).all(...dedupedIds) as {
      id: number;
    }[];
    const existingIds = new Set(existingRows.map((r) => r.id));
    const releaseIds = dedupedIds.filter((id) => existingIds.has(id));
    if (releaseIds.length === 0) {
      reply.code(400);
      return { error: 'none of the given releaseIds exist' };
    }

    const insert = db.prepare(
      `INSERT INTO shared_lists (id, title, description, category_id, release_ids, created_at)
       VALUES (@id, @title, @description, @category_id, @release_ids, @created_at)`,
    );
    const createdAt = new Date().toISOString();
    let id = generateId();
    for (let attempt = 0; ; attempt++) {
      try {
        insert.run({
          id,
          title,
          description,
          category_id: categoryId,
          release_ids: releaseIds.join(','),
          created_at: createdAt,
        });
        break;
      } catch (err) {
        // Only retry on the (astronomically unlikely) id collision -- any
        // other insert failure should surface normally.
        if (attempt >= 2 || !(err instanceof Error) || !err.message.includes('UNIQUE')) throw err;
        id = generateId();
      }
    }

    reply.code(201);
    return { id };
  });

  app.get('/api/lists/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const list = db.prepare('SELECT * FROM shared_lists WHERE id = ?').get(id) as
      | {
          id: string;
          title: string;
          description: string | null;
          category_id: number;
          release_ids: string;
          created_at: string;
        }
      | undefined;
    if (!list) {
      reply.code(404);
      return { error: 'not found' };
    }

    const releaseIds = list.release_ids.split(',').map(Number);
    const placeholders = releaseIds.map(() => '?').join(',');
    const releaseRows = db
      .prepare(`SELECT id, name, year, record_label, catalogue_number FROM releases WHERE id IN (${placeholders})`)
      .all(...(releaseIds as SqlParam[])) as {
      id: number;
      name: string;
      year: number;
      record_label: string | null;
      catalogue_number: string | null;
    }[];
    const releaseById = new Map(releaseRows.map((r) => [r.id, r]));

    const artistMap = new Map<number, { id: number; name: string }[]>();
    const artistRows = db
      .prepare(
        `SELECT ra.release_id, a.id, a.name FROM release_artists ra JOIN artists a ON a.id = ra.artist_id
         WHERE ra.release_id IN (${placeholders}) AND ra.importance = 1
         ORDER BY a.name COLLATE NOCASE ASC`,
      )
      .all(...(releaseIds as SqlParam[])) as { release_id: number; id: number; name: string }[];
    for (const row of artistRows) {
      const artists = artistMap.get(row.release_id) ?? [];
      artists.push({ id: row.id, name: row.name });
      artistMap.set(row.release_id, artists);
    }

    // Batch-read whatever's already cached in release_extras -- populated
    // either by a live per-release Discogs lookup (routes/torrents.ts) or
    // the bulk dump import (import/import-discogs-videos.mjs). This never
    // triggers a new Discogs API call itself, it just aggregates whatever
    // videos are already on file for the releases in this list.
    const extrasRows = db
      .prepare(`SELECT release_id, discogs_url, videos FROM release_extras WHERE release_id IN (${placeholders})`)
      .all(...(releaseIds as SqlParam[])) as { release_id: number; discogs_url: string | null; videos: string | null }[];
    const extrasByRelease = new Map(extrasRows.map((r) => [r.release_id, r]));

    const discogsVideos = releaseIds
      .filter((rid) => releaseById.has(rid))
      .flatMap((rid) => {
        const extra = extrasByRelease.get(rid);
        if (!extra?.videos) return [];
        const release = releaseById.get(rid)!;
        const artistNames = (artistMap.get(rid) ?? []).map((a) => a.name);
        return (JSON.parse(extra.videos) as { url: string; title: string }[]).map((v) => ({
          releaseId: rid,
          releaseName: release.name,
          artistNames,
          discogsUrl: extra.discogs_url,
          title: v.title,
          url: v.url,
        }));
      });

    return {
      id: list.id,
      title: list.title,
      description: list.description,
      categoryId: list.category_id,
      categoryName: collageCategoryName(list.category_id),
      createdAt: list.created_at,
      releases: releaseIds
        .filter((rid) => releaseById.has(rid))
        .map((rid) => {
          const r = releaseById.get(rid)!;
          return {
            id: r.id,
            name: r.name,
            year: r.year || null,
            recordLabel: r.record_label,
            catalogueNumber: r.catalogue_number,
            artists: artistMap.get(r.id) ?? [],
          };
        }),
      discogsVideos,
    };
  });
}
