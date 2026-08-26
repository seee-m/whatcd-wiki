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
//   node api/import/import-discogs-videos.mjs "https://data.discogs.com/?download=data%2F2026%2Fdiscogs_20260801_releases.xml.gz"
//
// The second form fetches and decompresses the dump in-stream -- the
// compressed download is never written to disk at all, only the small
// per-release fields that survive filtering ever get held anywhere. Use
// it when disk space near the target DB is tight (the dump is ~10GB
// compressed; there's no reason to spend that just to read through it
// once). Memory use is the same either way, since both forms build the
// same in-memory match index -- what changes is disk, not RAM.
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
import { Readable } from 'node:stream';

const DB_PATH =
  process.env.SQLITE_PATH || path.join(os.homedir(), 'Library/Application Support/whatcd-wiki/whatcd.sqlite');

const dumpSource = process.argv[2];
if (!dumpSource) {
  console.error(
    'Usage: node import-discogs-videos.mjs /path/to/discogs_YYYYMMDD_releases.xml.gz\n' +
      '   or: node import-discogs-videos.mjs "https://data.discogs.com/?download=...releases.xml.gz"',
  );
  process.exit(1);
}
const dumpDate = (dumpSource.match(/discogs_(\d{8})_releases/) ?? [])[1] ?? 'unknown';
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
//
// \p{L}/\p{N} (Unicode letter/number categories, not the ASCII [a-z0-9]
// this used to use) so a non-Latin title (Hebrew, Cyrillic, CJK, ...)
// keeps its actual characters instead of being stripped down to an empty
// string -- which silently made every such release unmatchable, and
// worse, made them all collide on the same near-empty key.
function normalize(name) {
  if (!name) return '';
  let s = decodeXmlEntities(name).normalize('NFD').replace(/[̀-ͯ]/g, '');
  const sortForm = s.match(/^(.*),\s*(the|a|an)$/i);
  if (sortForm) s = `${sortForm[2]} ${sortForm[1]}`;
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function matchKey(artist, title) {
  return `${normalize(artist)}|${normalize(title)}`;
}

// Catalogue numbers are precise identifiers, not free text -- "SK 032",
// "SK-032", and "SK032" are the same catalogue number, so inter-token
// separators are dropped entirely rather than collapsed to a space the
// way normalize() treats word text.
function normalizeCatno(catno) {
  if (!catno) return '';
  return catno.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// A second, independent match key alongside matchKey's artist|title --
// (label, catalogue number) is how physical releases are actually
// identified in the wild, so it catches releases matchKey misses purely
// because of title-text differences (translated titles, edition
// suffixes, punctuation) without loosening matchKey's own precision at
// all. Only used as a fallback when matchKey finds nothing (see main()).
function catalogKey(label, catno) {
  return `${normalize(label)}|${normalizeCatno(catno)}`;
}

// Streams the gunzipped dump and yields each `<release ...>...</release>`
// block as a string. Buffers only up to one release's worth of unconsumed
// text at a time (plus whatever's mid-flight in a single chunk) rather
// than ever holding the full multi-GB file -- release blocks are a few
// hundred bytes to a few KB each, so this stays small throughout. Uses
// StringDecoder (not chunk.toString()) so a multi-byte UTF-8 character
// split across two chunks doesn't get corrupted at the boundary.
async function* releaseBlocks(source) {
  const gunzip = zlib.createGunzip();
  let src;
  if (/^https?:\/\//i.test(source)) {
    // Streams straight from the network into gunzip -- the compressed
    // dump (~10GB) is never written to disk anywhere. Readable.fromWeb
    // bridges fetch()'s Web ReadableStream body into a Node stream so it
    // can be piped like any other source.
    const res = await fetch(source);
    if (!res.ok || !res.body) throw new Error(`Failed to fetch dump: HTTP ${res.status}`);
    src = Readable.fromWeb(res.body);
  } else {
    src = fs.createReadStream(source);
  }
  // `.pipe()` does NOT forward errors from the source stream to the
  // destination -- a real Node.js footgun, and the actual cause of a
  // production crash: a dropped connection mid-download threw an
  // unhandled 'error' event and killed the whole process instead of
  // being caught below. Forwarding it into gunzip's own error path means
  // the existing for-await/catch handles a network drop exactly like a
  // truncated local file.
  src.on('error', (err) => gunzip.destroy(err));
  src.pipe(gunzip);
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  // No try/catch here -- a dropped connection (or truncated local file)
  // propagates up to buildIndex, which decides whether to retry (for a
  // URL source) or just accept partial progress (for a local file, where
  // re-reading it would hit the identical truncation again).
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

  // <labels><label name="Svek" catno="SK032" id="5"/></labels> -- a
  // release can carry more than one (co-releases, or a different catno
  // per format), so every (name, catno) pair gets its own catalogKey
  // entry in the index (see buildIndex).
  const labelsMatch = block.match(/<labels>([\s\S]*?)<\/labels>/);
  const labels = labelsMatch
    ? [...labelsMatch[1].matchAll(/<label\s+([^>]*)\/>/g)]
        .map((m) => {
          const attrs = m[1];
          const name = attrs.match(/name="([^"]*)"/)?.[1];
          const catno = attrs.match(/catno="([^"]*)"/)?.[1];
          return name && catno && catno !== 'none' ? { name: copy(decodeXmlEntities(name)), catno: copy(catno) } : null;
        })
        .filter((l) => l !== null)
    : [];

  const year = Number(block.match(/<released>(\d{4})/)?.[1]) || null;

  return {
    discogsId: Number(idMatch[1]),
    title: copy(decodeXmlEntities(title)),
    artistNames,
    labels,
    year,
    videos,
  };
}

// A dropped connection partway through a ~10GB streamed fetch is a real,
// observed failure mode (hit it in production: died after 175s/6.4M
// releases with a socket-closed error). Range requests aren't honored by
// data.discogs.com (confirmed separately), so there's no way to resume
// from where it left off -- the only option is restarting the fetch from
// byte 0. That's fine: already-indexed releases stay in `index` across
// attempts (just get redundantly re-scanned until the point of the
// previous failure), so a retry costs time, not progress. Only applies to
// URL sources -- a truncated local file would hit the identical cutoff
// again, so that case just accepts partial progress immediately.
const MAX_FETCH_RETRIES = 5;

async function buildIndex(source) {
  const index = new Map(); // matchKey (artist|title) -> [{ discogsId, year, videos }]
  const catnoIndex = new Map(); // catalogKey (label|catno) -> [{ discogsId, year, videos }]
  let scanned = 0;
  let withVideos = 0;
  const startedAt = Date.now();
  const isUrl = /^https?:\/\//i.test(source);
  let attempt = 0;

  while (true) {
    try {
      for await (const block of releaseBlocks(source)) {
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
        for (const label of extracted.labels) {
          const key = catalogKey(label.name, label.catno);
          const bucket = catnoIndex.get(key);
          if (bucket) bucket.push(entry);
          else catnoIndex.set(key, [entry]);
        }
      }
      break; // the stream ended cleanly -- done
    } catch (err) {
      attempt++;
      console.warn(
        `Warning: dump stream ended early after ${scanned.toLocaleString()} releases scanned (${err?.message ?? err}).`,
      );
      if (!isUrl) {
        console.warn('Local file source -- not retrying (would hit the same cutoff). Using everything scanned so far.');
        break;
      }
      if (attempt > MAX_FETCH_RETRIES) {
        console.warn(`Giving up after ${MAX_FETCH_RETRIES} retries. Using everything scanned so far.`);
        break;
      }
      console.warn(`Restarting the fetch from the beginning (attempt ${attempt}/${MAX_FETCH_RETRIES})...`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  console.log(
    `Index built: ${scanned.toLocaleString()} releases scanned, ${withVideos.toLocaleString()} had a usable YouTube video, ` +
      `${index.size.toLocaleString()} distinct artist|title keys, ${catnoIndex.size.toLocaleString()} distinct label|catno keys.`,
  );
  return { index, catnoIndex };
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
  console.log(`Reading dump: ${dumpSource}`);
  console.log(`Writing to: ${DB_PATH}`);

  const { index, catnoIndex } = await buildIndex(dumpSource);

  const db = new DatabaseSync(DB_PATH);
  ensureSourceColumn(db);

  const releases = db
    .prepare(
      `SELECT r.id AS release_id, r.name AS release_name, r.year AS release_year,
              r.record_label AS record_label, r.catalogue_number AS catalogue_number,
              a.name AS artist_name
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
  const CATNO_SOURCE_TAG = `${SOURCE_TAG}-catno`;

  let matchedByTitle = 0;
  let matchedByCatno = 0;
  db.exec('BEGIN');
  try {
    for (const row of mainArtistByRelease.values()) {
      const titleKeyMatch = index.get(matchKey(row.artist_name, row.release_name));
      if (titleKeyMatch && titleKeyMatch.length > 0) {
        const best = pickBestCandidate(titleKeyMatch, row.release_year);
        insert.run(
          row.release_id,
          `https://www.discogs.com/release/${best.discogsId}`,
          JSON.stringify(best.videos),
          now,
          SOURCE_TAG,
        );
        matchedByTitle++;
        continue;
      }

      // Fallback only tried when the title/artist match found nothing --
      // (label, catalogue number) recovers releases matchKey misses
      // purely on title-text differences, without loosening matchKey's
      // own exact-match precision at all. Tagged with a distinct source
      // so this tier stays identifiable/reversible from the exact tier.
      if (row.record_label && row.catalogue_number) {
        const catnoMatch = catnoIndex.get(catalogKey(row.record_label, row.catalogue_number));
        if (catnoMatch && catnoMatch.length > 0) {
          const best = pickBestCandidate(catnoMatch, row.release_year);
          insert.run(
            row.release_id,
            `https://www.discogs.com/release/${best.discogsId}`,
            JSON.stringify(best.videos),
            now,
            CATNO_SOURCE_TAG,
          );
          matchedByCatno++;
        }
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const totalMatched = matchedByTitle + matchedByCatno;
  console.log(
    `Matched and wrote ${totalMatched.toLocaleString()} releases: ` +
      `${matchedByTitle.toLocaleString()} by title/artist (source = "${SOURCE_TAG}"), ` +
      `${matchedByCatno.toLocaleString()} by catalogue number (source = "${CATNO_SOURCE_TAG}").`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
