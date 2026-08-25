// Bulk-populates release_extras.videos from a Discogs monthly data dump
// (https://data.discogs.com/, `discogs_YYYYMMDD_releases.xml.gz`) instead
// of the one-release-at-a-time live API lookup (api/src/discogsRelease.ts).
// See the plan this came from: what.cd's catalog is permanently frozen
// (site closed 2016), so there's no ongoing need to re-check releases --
// one bulk pass covers the vast majority up front, and the existing live
// discovery/pre-warmer (api/src/routes/tv.ts) keeps running afterward as
// a fallback for whatever this couldn't confidently match.
//
// Usage:
//   node api/import/import-discogs-videos.mjs /path/to/discogs_20260801_releases.xml.gz
//
// Two passes:
//   1. Stream the (multi-GB, gzipped) dump once, building an in-memory
//      index of every release that has >=1 YouTube-embeddable video,
//      keyed by normalized "artist|title". Everything else (tracklist,
//      formats, notes, images, identifiers, non-YouTube videos) is
//      discarded immediately -- never held in memory or written anywhere.
//   2. One query over `releases` (music only), matched against that index
//      by the same "main artist" convention the live lookup uses, written
//      into release_extras exactly like a live lookup would (same table,
//      same JSON shape) -- so every existing read path (what.tv, the
//      regular release page) picks these up with zero other changes.

import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const DB_PATH =
  process.env.SQLITE_PATH || path.join(os.homedir(), 'Library/Application Support/whatcd-wiki/whatcd.sqlite');

const dumpPath = process.argv[2];
if (!dumpPath) {
  console.error('Usage: node import-discogs-videos.mjs /path/to/discogs_YYYYMMDD_releases.xml.gz');
  process.exit(1);
}
const dumpDate = (dumpPath.match(/discogs_(\d{8})_releases/) ?? [])[1] ?? 'unknown';
const SOURCE_TAG = `bulk-${dumpDate}`;

// Same as web/src/lib/youtube.ts / api/src/routes/tv.ts's YOUTUBE_ID_RE --
// only an actually-embeddable YouTube URL is worth keeping.
const YOUTUBE_ID_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/;

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXmlEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[ent] ?? m;
  });
}

// V8 can implement String.prototype.slice() and regex capture groups as
// "sliced strings" that hold a live reference into the *entire* original
// backing string rather than copying -- and String.replace() returns the
// original reference unchanged when there's nothing to replace (the
// common case: no XML entities), so decodeXmlEntities() doesn't reliably
// break that reference either. Every field extracted from a release block
// is a few characters, but the block itself is a slice of `buffer`, which
// itself is the entire decompressed stream concatenated so far -- so
// without this, every tiny title/artist/video string retained in the
// long-lived index would silently keep megabytes of "already discarded"
// stream data alive. Hit this for real: OOM'd near 4GB before the first
// progress log. Buffer.from(...).toString() forces a genuine, independent
// copy with no relationship to the source string's backing memory.
function copy(s) {
  return Buffer.from(s, 'utf8').toString('utf8');
}

// Discogs sometimes stores artist names in sort form ("Beatles, The") --
// rewritten to match how what.cd stores the same names ("The Beatles")
// before the rest of normalization (lowercase, strip accents/punctuation).
function normalize(name) {
  if (!name) return '';
  let s = decodeXmlEntities(name).normalize('NFD').replace(/[̀-ͯ]/g, '');
  const sortForm = s.match(/^(.*),\s*(the|a|an)$/i);
  if (sortForm) s = `${sortForm[2]} ${sortForm[1]}`;
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function matchKey(artist, title) {
  return `${normalize(artist)}|${normalize(title)}`;
}

// Streams the gunzipped dump and yields each `<release ...>...</release>`
// block as a string. Buffers only up to one release's worth of unconsumed
// text at a time (plus whatever's mid-flight in a single chunk) rather
// than ever holding the full multi-GB file -- release blocks are a few
// hundred bytes to a few KB each, so this stays small throughout. Uses
// StringDecoder (not chunk.toString()) so a multi-byte UTF-8 character
// split across two chunks doesn't get corrupted at the boundary.
async function* releaseBlocks(gzPath) {
  const gunzip = zlib.createGunzip();
  fs.createReadStream(gzPath).pipe(gunzip);
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  try {
    for await (const chunk of gunzip) {
      buffer += decoder.write(chunk);
      let start;
      while ((start = buffer.indexOf('<release ')) !== -1) {
        const end = buffer.indexOf('</release>', start);
        if (end === -1) break; // block not fully buffered yet -- wait for more data
        yield buffer.slice(start, end + '</release>'.length);
        buffer = buffer.slice(end + '</release>'.length);
      }
    }
  } catch (err) {
    // A dump cut short mid-download (this happened during testing with a
    // deliberately-truncated file, but could also happen for real if a
    // production download gets interrupted) ends the gzip stream with
    // Z_BUF_ERROR/"unexpected end of file" instead of a clean EOF. Better
    // to use everything scanned before the cutoff than to throw away a
    // long-running scan over one truncated tail -- surface it as a
    // warning and let the generator end normally.
    if (err?.code === 'Z_BUF_ERROR' || /unexpected end of file/i.test(err?.message ?? '')) {
      console.warn(`Warning: dump ended unexpectedly (${err.message}) -- using everything scanned up to the cutoff.`);
    } else {
      throw err;
    }
  }
}

function extractRelease(block) {
  const idMatch = block.match(/<release id="(\d+)"/);
  if (!idMatch) return null;

  const videosMatch = block.match(/<videos>([\s\S]*?)<\/videos>/);
  if (!videosMatch) return null; // no videos at all -- cheap early exit, most releases stop here

  const videos = [];
  const videoEntryRe = /<video\s+([^>]*)>([\s\S]*?)<\/video>/g;
  let vm;
  while ((vm = videoEntryRe.exec(videosMatch[1]))) {
    const attrs = vm[1];
    const src = attrs.match(/src="([^"]*)"/)?.[1];
    if (!src || !YOUTUBE_ID_RE.test(src)) continue;
    const embed = attrs.match(/embed="([^"]*)"/)?.[1];
    if (embed === 'false') continue; // Discogs itself flags this as non-embeddable
    const title = vm[2].match(/<title>([^<]*)<\/title>/)?.[1];
    videos.push({ url: copy(decodeXmlEntities(src)), title: copy(title ? decodeXmlEntities(title) : 'Video') });
    if (videos.length >= 5) break; // matches the live lookup's cap (discogsRelease.ts)
  }
  if (videos.length === 0) return null; // had <videos>, but none were usable YouTube links

  // Release-level <title> is unambiguous only up to where <tracklist>/
  // <videos> begin -- both track and video entries have their own
  // <title> children, and a naive whole-block match would grab those
  // instead of the release title.
  const cutoffCandidates = [block.indexOf('<tracklist>'), block.indexOf('<videos>')].filter((i) => i !== -1);
  const cutoff = cutoffCandidates.length ? Math.min(...cutoffCandidates) : block.length;
  const title = block.slice(0, cutoff).match(/<title>([^<]*)<\/title>/)?.[1];
  if (!title) return null;

  const artistsMatch = block.match(/<artists>([\s\S]*?)<\/artists>/);
  const artistNames = artistsMatch
    ? [...artistsMatch[1].matchAll(/<name>([^<]*)<\/name>/g)].map((m) => copy(m[1]))
    : [];
  if (artistNames.length === 0) return null;

  const year = Number(block.match(/<released>(\d{4})/)?.[1]) || null;

  return {
    discogsId: Number(idMatch[1]),
    title: copy(decodeXmlEntities(title)),
    artistNames,
    year,
    videos,
  };
}

async function buildIndex(gzPath) {
  const index = new Map(); // matchKey -> [{ discogsId, year, videos }]
  let scanned = 0;
  let withVideos = 0;
  const startedAt = Date.now();

  for await (const block of releaseBlocks(gzPath)) {
    scanned++;
    if (scanned % 200_000 === 0) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      const mem = process.memoryUsage();
      const rss = (mem.rss / 1024 / 1024).toFixed(0);
      const heap = (mem.heapUsed / 1024 / 1024).toFixed(0);
      console.log(
        `  scanned ${scanned.toLocaleString()} releases (${withVideos.toLocaleString()} with usable video) -- ${elapsed}s -- rss ${rss}MB heap ${heap}MB`,
      );
    }

    const extracted = extractRelease(block);
    if (!extracted) continue;
    withVideos++;

    const entry = { discogsId: extracted.discogsId, year: extracted.year, videos: extracted.videos };
    for (const artistName of extracted.artistNames) {
      const key = matchKey(artistName, extracted.title);
      const bucket = index.get(key);
      if (bucket) bucket.push(entry);
      else index.set(key, [entry]);
    }
  }

  console.log(
    `Index built: ${scanned.toLocaleString()} releases scanned, ${withVideos.toLocaleString()} had a usable YouTube video, ${index.size.toLocaleString()} distinct artist|title keys.`,
  );
  return index;
}

function pickBestCandidate(candidates, year) {
  if (candidates.length === 1 || !year) return candidates[0];
  let best = candidates[0];
  let bestDiff = Infinity;
  for (const c of candidates) {
    if (c.year == null) continue;
    const diff = Math.abs(c.year - year);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }
  return best;
}

function ensureSourceColumn(db) {
  const cols = db.prepare('PRAGMA table_info(release_extras)').all();
  if (!cols.some((c) => c.name === 'source')) {
    db.exec('ALTER TABLE release_extras ADD COLUMN source TEXT');
  }
}

async function main() {
  console.log(`Reading dump: ${dumpPath}`);
  console.log(`Writing to: ${DB_PATH}`);

  const index = await buildIndex(dumpPath);

  const db = new DatabaseSync(DB_PATH);
  ensureSourceColumn(db);

  const releases = db
    .prepare(
      `SELECT r.id AS release_id, r.name AS release_name, r.year AS release_year, a.name AS artist_name
       FROM releases r
       JOIN release_artists ra ON ra.release_id = r.id AND ra.importance = 1
       JOIN artists a ON a.id = ra.artist_id
       WHERE r.category_id = 1
       ORDER BY r.id, a.name COLLATE NOCASE ASC`,
    )
    .all();

  // Same "one main artist, alphabetically first if several" rule the live
  // lookup uses (api/src/routes/torrents.ts) -- keeps bulk- and live-
  // matched releases consistent with each other. Rows are pre-sorted by
  // (release_id, artist name), so the first row seen per release_id is
  // already the right one.
  const mainArtistByRelease = new Map();
  for (const row of releases) {
    if (!mainArtistByRelease.has(row.release_id)) {
      mainArtistByRelease.set(row.release_id, row);
    }
  }
  console.log(`${mainArtistByRelease.size.toLocaleString()} music releases have a main artist to match against.`);

  const insert = db.prepare(
    'INSERT OR REPLACE INTO release_extras (release_id, discogs_url, videos, fetched_at, source) VALUES (?, ?, ?, ?, ?)',
  );
  const now = new Date().toISOString();

  let matched = 0;
  db.exec('BEGIN');
  try {
    for (const row of mainArtistByRelease.values()) {
      const key = matchKey(row.artist_name, row.release_name);
      const candidates = index.get(key);
      if (!candidates || candidates.length === 0) continue;

      const best = pickBestCandidate(candidates, row.release_year);
      insert.run(
        row.release_id,
        `https://www.discogs.com/release/${best.discogsId}`,
        JSON.stringify(best.videos),
        now,
        SOURCE_TAG,
      );
      matched++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.log(`Matched and wrote ${matched.toLocaleString()} releases (source = "${SOURCE_TAG}").`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
