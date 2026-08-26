import type { FastifyInstance } from 'fastify';
import { db, type SqlParam } from '../db.js';

// what.tv picks a random release matching the caller's tag/year/type
// filters that has at least one *YouTube* video on file, since the whole
// point of the page is a big embedded YouTube player -- Discogs videos
// aren't always YouTube (Vimeo etc. show up occasionally), and those aren't
// embeddable by web/src/lib/youtube.ts, so a release with only non-YouTube
// videos is exactly as dead-end as one with none.
const MUSIC_CATEGORY_ID = 1;

// what.tv reads release_extras and nothing else. It does NOT call Discogs.
//
// It used to: a background pre-warmer ticked every 8 seconds forever, one
// roll in five kicked off a live discovery batch, and a cold filter combo
// blocked the request on a Discogs round-trip. That machinery predates the
// bulk dump importer (import/import-discogs-videos.mjs), which is now where
// videos come from -- 421,052 of the 432,605 rows on file arrived that way
// against 11,553 from live discovery, so the live path was contributing a
// rounding error's worth of coverage while making Discogs calls forever and
// blocking the one JS thread to do it. Videos come from dump imports now;
// run the importer to grow the pool.
//
// The release page (routes/torrents.ts) still falls back to a live Discogs
// lookup on a cache miss -- that's a single deliberate request for a
// release someone is actually looking at, not a crawl.

// Below this many known-playable releases for a filter combo, the frontend
// warns that the station will be repetitive (see TvPlay.tsx).
const POOL_HEALTHY_SIZE = 12;

// Mirrors web/src/lib/youtube.ts's youtubeVideoId regex -- kept as a
// separate copy rather than a shared package since it's one line and the
// two projects don't otherwise share code.
const YOUTUBE_ID_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/;
function youtubeId(url: string): string | null {
  return url.match(YOUTUBE_ID_RE)?.[1] ?? null;
}

// "Next" used to re-run the random draw every single time, and that draw is
// the expensive part of what.tv: it walks every music release matching the
// filters, probes release_extras for each, then sorts the lot into a temp
// b-tree to keep one row -- 209ms unfiltered against the real database.
// Since node:sqlite is synchronous, that is 209ms of the one JS thread
// blocked for every other visitor too, and a station left playing
// auto-advances into it at the end of every track.
//
// Drawing several picks at once costs the same as drawing one (measured:
// LIMIT 8 at 192ms vs LIMIT 1 at 216ms -- the scan and sort dominate, the
// LIMIT is free), so each draw now fills a small per-filter queue and the
// next few Nexts are answered from memory. When the queue runs low it is
// topped up on a setImmediate, off the request path, so a visitor only ever
// waits for a draw if they empty the queue faster than it refills.
//
// This does not change the distribution: ORDER BY RANDOM() LIMIT n returns
// a uniformly random sample in random order, so each id served is still a
// uniform draw over the matching releases. The only difference from drawing
// one at a time is that a single batch won't repeat a release inside itself
// -- which for a radio is the better behaviour anyway.
const READY_PICKS = 8;
const REFILL_WHEN_BELOW = 5;
const MAX_TRACKED_COMBOS = 64;

interface ReadyPool {
  ids: number[];
  healthy: boolean;
}

const readyPools = new Map<string, ReadyPool>();
const refillsInFlight = new Set<string>();

// Deliberately excludes `exclude`: it carries the release currently
// playing and so differs on every Next, which would make each request its
// own cache key and defeat the whole thing. It's applied in JS at serve
// time instead (see takeReadyPick).
function poolKey(tagIds: number[], typeIds: number[], yearFrom?: number, yearTo?: number): string {
  return JSON.stringify([[...tagIds].sort((a, b) => a - b), [...typeIds].sort((a, b) => a - b), yearFrom ?? null, yearTo ?? null]);
}

function rememberPool(key: string, pool: ReadyPool): void {
  readyPools.delete(key);
  readyPools.set(key, pool);
  // Map iterates in insertion order and every read re-inserts, so the first
  // key is the least recently used one.
  while (readyPools.size > MAX_TRACKED_COMBOS) {
    const oldest = readyPools.keys().next().value;
    if (oldest === undefined) break;
    readyPools.delete(oldest);
  }
}

// A queued id can go stale between being drawn and being served -- the
// player reports dead videos (see /video-dead below) and prunes them, so a
// release that had a video when drawn may have none by now. That's one
// indexed lookup to rule out, far cheaper than serving a release the player
// will immediately skip.
const stillHasVideoStmt = () =>
  db.prepare("SELECT 1 AS ok FROM release_extras WHERE release_id = ? AND videos IS NOT NULL AND videos != '[]'");

function takeReadyPick(pool: ReadyPool, exclude: number | undefined): number | null {
  const check = stillHasVideoStmt();
  while (pool.ids.length > 0) {
    const id = pool.ids.shift()!;
    if (id === exclude) continue;
    if (check.get(id)) return id;
  }
  return null;
}

function drawPicks(fromClause: string, whereClause: string, params: SqlParam[], limit: number): number[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT r.id ${fromClause}
         JOIN release_extras re ON re.release_id = r.id
         ${whereClause} AND re.videos IS NOT NULL AND re.videos != '[]'
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(...params, limit) as { id: number }[]
  ).map((r) => r.id);
}

// Deferred to a setImmediate so the draw lands after the current response
// has gone out. It still blocks the thread while it runs -- node:sqlite is
// synchronous and nothing can change that -- but it blocks between
// requests rather than inside one, and now happens once per READY_PICKS
// Nexts instead of once per Next.
function scheduleRefill(key: string, fromClause: string, whereClause: string, params: SqlParam[], healthy: boolean): void {
  if (refillsInFlight.has(key)) return;
  refillsInFlight.add(key);
  setImmediate(() => {
    try {
      const existing = readyPools.get(key);
      const ids = drawPicks(fromClause, whereClause, params, READY_PICKS);
      if (ids.length > 0) {
        const merged = [...(existing?.ids ?? []), ...ids.filter((id) => !existing?.ids.includes(id))];
        rememberPool(key, { ids: merged.slice(0, READY_PICKS * 2), healthy });
      }
    } catch {
      // Best-effort top-up -- the next request just draws synchronously.
    } finally {
      refillsInFlight.delete(key);
    }
  });
}

function parseIds(raw: string | undefined): number[] {
  return (raw ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

export default async function tvRoutes(app: FastifyInstance) {
  app.get('/api/tv/random', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const tagIds = parseIds(q.tags);
    const typeIds = parseIds(q.type);
    const yearFrom = q.yearFrom ? Number(q.yearFrom) : undefined;
    const yearTo = q.yearTo ? Number(q.yearTo) : undefined;
    const exclude = q.exclude ? Number(q.exclude) : undefined;

    // Driving the query from `releases r` and filtering tags with an EXISTS
    // subquery looked right but wasn't: SQLite still has to SCAN every one
    // of the ~1M rows in `releases` and run the (indexed, but still
    // per-row) EXISTS check against each one -- confirmed with EXPLAIN
    // QUERY PLAN, and it cost the same ~230ms whether the tag matched
    // 500,000 releases or 1. On an always-on single-CPU box, that's ~230ms
    // of the one Node thread blocked on every other visitor's request too
    // (node:sqlite queries are synchronous), for no reason: release_tags
    // has an index on tag_id (idx_release_tags_tag), so driving from there
    // instead turns "scan a million releases" into "look up the ~handful
    // of rows for this tag." DISTINCT is required once we do this, since a
    // release matching 2+ of the selected tags would otherwise appear
    // twice in the join -- which was also a latent randomness bug (it'd
    // get double the chance of being picked).
    let fromClause = 'FROM releases r';
    const where: string[] = ['r.category_id = ?'];
    const params: SqlParam[] = [MUSIC_CATEGORY_ID];
    if (tagIds.length > 0) {
      fromClause = 'FROM release_tags rtf JOIN releases r ON r.id = rtf.release_id';
      where.push(`rtf.tag_id IN (${tagIds.map(() => '?').join(',')})`);
      params.push(...tagIds);
    }
    if (typeIds.length > 0) {
      where.push(`r.release_type IN (${typeIds.map(() => '?').join(',')})`);
      params.push(...typeIds);
    }
    if (yearFrom !== undefined && Number.isFinite(yearFrom)) {
      where.push('r.year >= ?');
      params.push(yearFrom);
    }
    if (yearTo !== undefined && Number.isFinite(yearTo)) {
      where.push('r.year <= ?');
      params.push(yearTo);
    }
    const whereClause = `WHERE ${where.join(' AND ')}`;

    // The currently-playing release is filtered out separately rather than
    // folded into whereClause/params above: it changes on every Next, so
    // baking it in would give each request a distinct ready-pool key and
    // no pick would ever be reused. Queries that still want it append it;
    // the ready pool skips the id in JS instead (takeReadyPick).
    const hasExclude = exclude !== undefined && Number.isInteger(exclude);
    const whereClauseExcl = hasExclude ? `${whereClause} AND r.id != ?` : whereClause;
    const paramsExcl: SqlParam[] = hasExclude ? [...params, exclude] : params;

    // Serve a pick drawn on an earlier request if one is waiting -- this is
    // the path that makes "Next" instant instead of a 209ms draw.
    const key = poolKey(tagIds, typeIds, yearFrom, yearTo);
    const ready = readyPools.get(key);
    if (ready) {
      const queued = takeReadyPick(ready, exclude);
      if (queued !== null) {
        rememberPool(key, ready);
        if (ready.ids.length < REFILL_WHEN_BELOW) {
          scheduleRefill(key, fromClause, whereClause, params, ready.healthy);
        }
        return { id: queued, poolHealthy: ready.healthy, poolThreshold: POOL_HEALTHY_SIZE };
      }
      readyPools.delete(key);
    }

    // How many releases matching these filters are already known (from a
    // prior /extras lookup, here or on the release's own page) to have a
    // YouTube video -- capped at POOL_HEALTHY_SIZE + 1 so this stays cheap
    // even once release_extras has grown large (LIMIT stops the scan early;
    // no ORDER BY needed since we only care how many, not which).
    const cachedMatches = db
      .prepare(
        `SELECT DISTINCT r.id ${fromClause}
         JOIN release_extras re ON re.release_id = r.id
         ${whereClauseExcl} AND re.videos IS NOT NULL AND re.videos != '[]'
         LIMIT ?`,
      )
      .all(...paramsExcl, POOL_HEALTHY_SIZE + 1) as { id: number }[];

    const poolIsHealthy = cachedMatches.length > POOL_HEALTHY_SIZE;

    if (cachedMatches.length > 0) {
      // Same draw as before, just keeping the rest of what it returns
      // instead of throwing it away -- LIMIT READY_PICKS costs what
      // LIMIT 1 cost, so the following few Nexts come free.
      let pick: number;
      if (poolIsHealthy) {
        const drawn = drawPicks(fromClause, whereClause, params, READY_PICKS);
        const usable = drawn.filter((id) => id !== exclude);
        // A draw this size effectively always returns something on a
        // healthy pool, but fall back rather than assume it.
        pick = usable.length > 0 ? usable[0] : cachedMatches[Math.floor(Math.random() * cachedMatches.length)].id;
        if (usable.length > 1) rememberPool(key, { ids: usable.slice(1), healthy: true });
      } else {
        pick = cachedMatches[Math.floor(Math.random() * cachedMatches.length)].id;
      }

      // poolHealthy/poolThreshold let the frontend tell the visitor this
      // station has little to draw on and will repeat itself (see
      // TvPlay.tsx's warning box).
      return { id: pick, poolHealthy: poolIsHealthy, poolThreshold: POOL_HEALTHY_SIZE };
    }

    // Nothing on file for these filters. This used to block the caller on
    // up to six throttled Discogs round-trips hoping to turn one up, which
    // is where "Next sometimes takes 10-20 seconds" came from. There is
    // nothing to wait for now -- say so straight away.
    reply.code(404);
    return { error: 'No releases with video found for these filters. Try broadening your search.' };
  });

  // Reports that the video the player just tried to play is actually dead
  // (removed, privated, or embedding-disabled -- the YouTube IFrame API's
  // onError event, see web/src/pages/TvPlay.tsx). This is the only
  // trustworthy signal that a cached video has rotted: Discogs itself
  // doesn't know its own video links have died, so re-querying Discogs
  // wouldn't catch this -- only an actual failed playback attempt does,
  // and it costs nothing extra since the player was going to try loading
  // it anyway. Prunes just that one video from the release's cached list,
  // so a release with 2+ videos and one dead link stays in the safe pool.
  app.post('/api/tv/:id/video-dead', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as { url?: string } | undefined;
    const deadId = body?.url ? youtubeId(body.url) : null;
    if (!Number.isInteger(id) || !deadId) {
      reply.code(400);
      return { error: 'invalid request' };
    }

    const row = db.prepare('SELECT videos FROM release_extras WHERE release_id = ?').get(id) as
      | { videos: string | null }
      | undefined;
    if (!row?.videos) return { removed: false };

    const videos = JSON.parse(row.videos) as { url: string; title: string }[];
    const remaining = videos.filter((v) => youtubeId(v.url) !== deadId);
    if (remaining.length === videos.length) return { removed: false };

    db.prepare('UPDATE release_extras SET videos = ? WHERE release_id = ?').run(JSON.stringify(remaining), id);
    return { removed: true, remaining: remaining.length };
  });
}
