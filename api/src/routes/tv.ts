import type { FastifyInstance } from 'fastify';
import { db, type SqlParam } from '../db.js';
import { fetchDiscogsExtras } from '../discogsRelease.js';

// what.tv picks a random release matching the caller's tag/year/type filters
// and requires it to have at least one *YouTube* Discogs video, since the
// whole point of the page is a big embedded YouTube player -- Discogs
// videos aren't always YouTube (Vimeo etc. show up occasionally), and those
// aren't embeddable by web/src/lib/youtube.ts, so a release with only
// non-YouTube videos is exactly as dead-end as one with none. Same category
// restriction as cover/extras lookups (routes/torrents.ts) -- only music
// releases get Discogs videos looked up.
const MUSIC_CATEGORY_ID = 1;

// Live Discogs lookups (2 HTTP calls each) are only attempted for releases
// that have never been checked before -- capped so one "Next" click can't
// spend unbounded time on a narrow/empty filter combo.
const MAX_LIVE_ATTEMPTS = 6;

// Once this many releases matching a given filter combo are *known* (from
// release_extras) to have a YouTube video, a plain random SQL pick from
// that set gives plenty of variety on its own -- below it, discovery always
// runs (see POOL_HEALTHY_SIZE's use below) so a thin pool never freezes at
// whatever was found first.
const POOL_HEALTHY_SIZE = 12;

// Even once a filter combo's pool is "healthy", keep discovering on this
// fraction of rolls anyway -- otherwise the reachable set permanently caps
// out at POOL_HEALTHY_SIZE-ish and "Next" is a shuffle of the same dozen
// releases forever instead of eventually reaching every release that has a
// video. Combined with the background pre-warmer below, this is what makes
// "any release with a YouTube video" the actual long-run target rather
// than "whichever ones got discovered first".
const EXPLORE_PROBABILITY = 0.2;

// Mirrors web/src/lib/youtube.ts's youtubeVideoId regex -- kept as a
// separate copy rather than a shared package since it's one line and the
// two projects don't otherwise share code.
const YOUTUBE_ID_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/;
function youtubeId(url: string): string | null {
  return url.match(YOUTUBE_ID_RE)?.[1] ?? null;
}

function parseIds(raw: string | undefined): number[] {
  return (raw ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

// Checks one never-looked-up release against Discogs and caches the result
// -- shared by the live discovery loop below and the background
// pre-warmer, so there's exactly one place that writes release_extras from
// a fresh lookup. Returns whether it turned out to have a playable video.
async function checkCandidateForVideo(id: number, name: string): Promise<boolean> {
  const primaryArtist = db
    .prepare(
      `SELECT a.name FROM release_artists ra JOIN artists a ON a.id = ra.artist_id
       WHERE ra.release_id = ? AND ra.importance = 1 ORDER BY a.name LIMIT 1`,
    )
    .get(id) as { name: string } | undefined;

  const result = await fetchDiscogsExtras(primaryArtist?.name ?? '', name).catch(() => null);
  const youtubeVideos = result?.videos.filter((v) => youtubeId(v.url)) ?? [];

  // Cached with only the YouTube-embeddable videos kept -- this row is
  // shared with the regular release page's /extras endpoint, so a
  // non-YouTube video Discogs returned (Vimeo etc.) is simply dropped
  // rather than stored dead, since neither page can embed it anyway.
  db.prepare(
    'INSERT OR REPLACE INTO release_extras (release_id, discogs_url, videos, fetched_at) VALUES (?, ?, ?, ?)',
  ).run(id, result?.discogsUrl ?? null, result ? JSON.stringify(youtubeVideos) : null, new Date().toISOString());

  return youtubeVideos.length > 0;
}

// Samples up to MAX_LIVE_ATTEMPTS never-looked-up releases matching the
// given filters. Shared by the cold-start path (which awaits it directly)
// and the background-discovery path below (which doesn't).
function fetchUncachedCandidates(
  fromClause: string,
  whereClause: string,
  params: SqlParam[],
): { id: number; name: string }[] {
  return db
    .prepare(
      `SELECT DISTINCT r.id, r.name ${fromClause}
       LEFT JOIN release_extras re ON re.release_id = r.id
       ${whereClause} AND re.release_id IS NULL
       ORDER BY RANDOM() LIMIT ?`,
    )
    .all(...params, MAX_LIVE_ATTEMPTS) as { id: number; name: string }[];
}

// Checks a batch of candidates one at a time, same throttled/sequential
// pace as before -- the only difference from the old inline loop is that
// nothing here is awaited by the request handler, so it can't add a
// single millisecond to the response the caller already got.
async function discoverCandidatesInBackground(candidates: { id: number; name: string }[]): Promise<void> {
  for (const candidate of candidates) {
    try {
      await checkCandidateForVideo(candidate.id, candidate.name);
    } catch {
      // Best-effort background growth -- move on to the next candidate.
    }
  }
}

// Used by the "healthy pool, but this roll landed in the explore slice"
// case: samples fresh candidates and checks them, entirely after the
// response for the triggering request has already been sent.
async function discoverInBackground(fromClause: string, whereClause: string, params: SqlParam[]): Promise<void> {
  try {
    await discoverCandidatesInBackground(fetchUncachedCandidates(fromClause, whereClause, params));
  } catch {
    // Best-effort background growth.
  }
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
    if (exclude !== undefined && Number.isInteger(exclude)) {
      where.push('r.id != ?');
      params.push(exclude);
    }
    const whereClause = `WHERE ${where.join(' AND ')}`;

    // How many releases matching these filters are already known (from a
    // prior /extras lookup, here or on the release's own page) to have a
    // YouTube video -- capped at POOL_HEALTHY_SIZE + 1 so this stays cheap
    // even once release_extras has grown large (LIMIT stops the scan early;
    // no ORDER BY needed since we only care how many, not which).
    const cachedMatches = db
      .prepare(
        `SELECT DISTINCT r.id ${fromClause}
         JOIN release_extras re ON re.release_id = r.id
         ${whereClause} AND re.videos IS NOT NULL AND re.videos != '[]'
         LIMIT ?`,
      )
      .all(...params, POOL_HEALTHY_SIZE + 1) as { id: number }[];

    const poolIsHealthy = cachedMatches.length > POOL_HEALTHY_SIZE;
    const shouldExplore = !poolIsHealthy || Math.random() < EXPLORE_PROBABILITY;

    // The actual fix for "Next sometimes takes 10-20s": whenever there's
    // already *something* to offer (any cached match at all, not just a
    // fully "healthy" pool), respond immediately and let any discovery
    // needed for pool growth continue in the background. Previously this
    // synchronously awaited the whole discovery loop below even on an
    // already-healthy pool whenever a roll landed in the 20% explore
    // slice -- despite having a perfectly good cached answer sitting
    // right there, one in five rolls on a *healthy* tag still paid the
    // full up-to-6-candidate, throttled-Discogs-call cost before
    // responding. Nobody should ever have to wait through a Discogs
    // round-trip just because the pool could stand to be bigger.
    if (cachedMatches.length > 0) {
      const pick = poolIsHealthy
        ? (
            db
              .prepare(
                `SELECT DISTINCT r.id ${fromClause}
                 JOIN release_extras re ON re.release_id = r.id
                 ${whereClause} AND re.videos IS NOT NULL AND re.videos != '[]'
                 ORDER BY RANDOM() LIMIT 1`,
              )
              .get(...params) as { id: number }
          ).id
        : cachedMatches[Math.floor(Math.random() * cachedMatches.length)].id;

      if (shouldExplore) {
        void discoverInBackground(fromClause, whereClause, params);
      }
      // poolHealthy/poolThreshold let the frontend warn upfront that
      // "Next" might be slow for this filter combo (see TvPlay.tsx's
      // warning box) -- this pick was fast either way, but the *next*
      // roll on the same combo might not be if it's still thin.
      return { id: pick, poolHealthy: poolIsHealthy, poolThreshold: POOL_HEALTHY_SIZE };
    }

    // Totally cold (zero cached matches): this request has no choice but
    // to wait for the first live hit, since there's nothing else to
    // offer -- but it stops as soon as one is found rather than checking
    // the full batch, and hands off whatever candidates are left to the
    // same background path once it does.
    const candidates = fetchUncachedCandidates(fromClause, whereClause, params);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (await checkCandidateForVideo(candidate.id, candidate.name)) {
        const rest = candidates.slice(i + 1);
        if (rest.length > 0) void discoverCandidatesInBackground(rest);
        return { id: candidate.id, poolHealthy: false, poolThreshold: POOL_HEALTHY_SIZE };
      }
    }

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

// Slow, continuous background discovery -- decoupled entirely from user
// requests, so it costs nothing on the request path. Ticks once every
// PREWARM_INTERVAL_MS, each tick checking exactly one never-looked-up
// music release against Discogs, so coverage keeps growing globally (not
// just for tags/filters someone happens to roll) even with zero visitors.
// At the default interval that's ~7.5 releases/min (~15 Discogs calls/min
// worst case), comfortably under Discogs' ~60/min budget with plenty of
// headroom left for live user-triggered discovery too -- raise the
// interval to warm up faster at the cost of more sustained Discogs
// traffic, or lower it to ease off further.
const PREWARM_INTERVAL_MS = 8000;

export function startTvPrewarm(): void {
  if (!process.env.DISCOGS_TOKEN) return; // fetchDiscogsExtras is a no-op without one anyway
  setInterval(() => {
    void prewarmTick();
  }, PREWARM_INTERVAL_MS);
}

async function prewarmTick(): Promise<void> {
  try {
    const bounds = db.prepare('SELECT MIN(id) lo, MAX(id) hi FROM releases WHERE category_id = ?').get(
      MUSIC_CATEGORY_ID,
    ) as { lo: number | null; hi: number | null };
    if (bounds.lo === null || bounds.hi === null) return;

    // A random id seek (`id >= seed ORDER BY id LIMIT 1`) walks the
    // releases primary-key index instead of scanning the table -- cheap
    // even at ~1M rows. Not perfectly uniform (ids just after a run of
    // already-checked ones get hit more often), which is fine here: this
    // job's only goal is steadily covering the whole catalog over time,
    // not a fair per-tick sample.
    const seed = bounds.lo + Math.floor(Math.random() * (bounds.hi - bounds.lo + 1));
    const candidate = db
      .prepare(
        `SELECT r.id, r.name FROM releases r
         LEFT JOIN release_extras re ON re.release_id = r.id
         WHERE r.category_id = ? AND r.id >= ? AND re.release_id IS NULL
         ORDER BY r.id LIMIT 1`,
      )
      .get(MUSIC_CATEGORY_ID, seed) as { id: number; name: string } | undefined;
    if (!candidate) return; // nothing uncached at/after this seed this tick

    await checkCandidateForVideo(candidate.id, candidate.name);
  } catch {
    // Best-effort background job -- swallow and try again next tick.
  }
}
