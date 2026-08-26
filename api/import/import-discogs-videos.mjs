// Bulk-populates release_extras.videos from Discogs' monthly data dumps
// (https://data.discogs.com/) instead of the one-release-at-a-time live API
// lookup (api/src/discogsRelease.ts). What.cd's catalog is permanently
// frozen (site closed 2016), so there's no ongoing need to re-check
// releases -- one bulk pass covers the vast majority up front, and the
// release page's live /extras fallback covers whatever this couldn't
// confidently match.
//
// Usage:
//   node api/import/import-discogs-videos.mjs /path/to/discogs_20260801_releases.xml.gz
//   node api/import/import-discogs-videos.mjs "https://data.discogs.com/?download=data%2F2026%2Fdiscogs_20260801_releases.xml.gz"
//   node api/import/import-discogs-videos.mjs <source> --rerun
//
// The second form fetches and decompresses each dump in-stream -- the
// compressed download is never written to disk at all, only the small
// per-entry fields that survive filtering ever get held anywhere.
//
// If this month's dump has already been imported, the run asks whether to
// re-stream the releases dump anyway (needed after a change to the
// matching rules below, which is the only reason the same dump would
// produce a different answer than it did last time). --rerun answers yes
// up front, and is the only way to say yes when stdin isn't a terminal --
// which is exactly how the production wrapper runs this, detached under
// nohup, where a prompt would hang forever instead of being answered.
//
// Two dumps, and a fixed ladder of matching rules applied against each:
//   1. Releases dump (~10GB compressed) -- full index of every release
//      (specific pressing) with a usable YouTube video. Skipped unless
//      --rerun if release_extras already has rows tagged with this
//      month's dump (source LIKE "bulk-YYYYMMDD%").
//   2. Masters dump (~600MB compressed, ~6% the size) -- one entry per
//      canonical work rather than per pressing, with its own videos list
//      pooled across every pressing (a video entered against a 2024
//      remaster reissue shows up here even if the specific pressing that
//      matches a whatcd release never had a video of its own). Runs over
//      whatever the releases dump left unmatched -- built as a targeted
//      lookup against a pre-computed set of wanted keys, not a full
//      index, so memory stays bounded regardless of how much of the dump
//      gets scanned (see buildMastersMatches).
//
// The matching rules themselves live in one place, MATCH_RULES, and are
// shared by both dumps. They run in strict confidence order and the first
// one to find a candidate wins, so a fuzzy rule can never take a release
// that a more exact rule could have claimed. Each rule writes its own
// release_extras.source tag, so any single rule can be audited -- or
// undone with one DELETE -- without disturbing the others.
//
// Finally, releases matched exactly are *enriched* rather than left
// alone: the releases dump hands us each release's master id outright, so
// a pressing that carried only one video gets the rest of its master's
// videos appended (see enrichExactMatchesFromMasters). That is not a
// fuzzy match, it's the same record, and it matters because what.tv drops
// a release from the pool the moment its only video 404s.

import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Readable } from 'node:stream';
import readline from 'node:readline/promises';

const DB_PATH =
  process.env.SQLITE_PATH || path.join(os.homedir(), 'Library/Application Support/whatcd-wiki/whatcd.sqlite');

const argv = process.argv.slice(2);
const FORCE_RERUN = argv.includes('--rerun');
const releasesDumpSource = argv.find((a) => !a.startsWith('--'));
if (!releasesDumpSource) {
  console.error(
    'Usage: node import-discogs-videos.mjs /path/to/discogs_YYYYMMDD_releases.xml.gz [--rerun]\n' +
      '   or: node import-discogs-videos.mjs "https://data.discogs.com/?download=...releases.xml.gz" [--rerun]',
  );
  process.exit(1);
}
const dumpDate = (releasesDumpSource.match(/discogs_(\d{8})_releases/) ?? [])[1] ?? 'unknown';
const SOURCE_TAG = `bulk-${dumpDate}`;
const MASTER_SOURCE_TAG = `${SOURCE_TAG}-master`;

// Masters dumps live at the same path/date as the releases dump, just a
// different filename -- deriving it avoids the wrapper script having to
// resolve a second URL.
const mastersDumpSource = releasesDumpSource.replace('_releases.xml.gz', '_masters.xml.gz');
if (mastersDumpSource === releasesDumpSource) {
  console.error(`Couldn't derive a masters dump path from: ${releasesDumpSource}`);
  process.exit(1);
}

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
// break that reference either. Every field extracted from a block is a
// few characters, but the block itself is a slice of `buffer`, which
// itself is the entire decompressed stream concatenated so far -- so
// without this, every tiny title/artist/video string retained anywhere
// would silently keep megabytes of "already discarded" stream data alive.
// Hit this for real: OOM'd near 4GB before the first progress log.
// Buffer.from(...).toString() forces a genuine, independent copy with no
// relationship to the source string's backing memory.
function copy(s) {
  return Buffer.from(s, 'utf8').toString('utf8');
}

// Abbreviations whatcd and Discogs disagree about constantly, expanded on
// BOTH sides so the two spellings collapse onto one key. Symmetric by
// construction: this can only ever merge keys that should have been the
// same, never split ones that already matched.
const ABBREVIATIONS = [
  [/\bvol\b/g, 'volume'],
  [/\bpt\b/g, 'part'],
  [/\bfeat\b/g, 'featuring'],
  [/\bft\b/g, 'featuring'],
  [/\bvs\b/g, 'versus'],
];

// Discogs sometimes stores artist names in sort form ("Beatles, The") --
// rewritten to match how what.cd stores the same names ("The Beatles")
// before the rest of normalization (lowercase, strip accents/punctuation).
//
// \p{L}/\p{N} (Unicode letter/number categories, not the ASCII [a-z0-9]
// this used to use) so a non-Latin title (Hebrew, Cyrillic, CJK, ...)
// keeps its actual characters instead of being stripped down to an empty
// string -- which silently made every such release unmatchable, and
// worse, made them all collide on the same near-empty key.
//
// NFKC before NFD folds the compatibility forms Discogs picks up from
// Japanese pressings -- full-width Latin, circled and squared characters,
// ligatures -- onto their plain equivalents. NFD alone left "ＡＢＣ" and
// "ABC" as different keys.
//
// isArtist drops a leading "The", which is worth 1,041 matches against
// the masters dump on its own: "The Oscar Peterson Trio" and "Oscar
// Peterson Trio" are the same act and both spellings are in live use on
// both sides. Deliberately not applied to titles, where a leading "The"
// genuinely distinguishes records.
function normalize(name, isArtist = false) {
  if (!name) return '';
  let s = decodeXmlEntities(name)
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const sortForm = s.match(/^(.*),\s*(the|a|an)$/i);
  if (sortForm) s = `${sortForm[2]} ${sortForm[1]}`;
  s = s
    .toLowerCase()
    .replace(/&/g, ' and ') // "A & B" vs "A and B" -- otherwise & is just dropped below and the two never match
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  for (const [pattern, expansion] of ABBREVIATIONS) s = s.replace(pattern, expansion);
  if (isArtist) s = s.replace(/^the\s+/, '');
  return s.trim().replace(/\s+/g, ' ');
}

// Discogs disambiguates same-named artists with a trailing index -- e.g.
// "Nirvana (2)", "Genesis (5)" -- purely a Discogs database artifact,
// never part of the actual artist name. Without stripping it, normalize()
// turns it into a stray digit token ("nirvana 2") that silently blocks a
// match against whatcd's plain "Nirvana". Only applied to the artist
// field (not title) to keep it precise.
function stripArtistDisambiguation(name) {
  return name.replace(/\s*\(\d+\)\s*$/, '');
}

// Discogs and whatcd don't consistently agree on "Various" vs "Various
// Artists" for compilations -- canonicalize both to the same token after
// the rest of normalization runs, rather than loosening normalize() itself.
function canonicalizeVarious(normalizedArtist) {
  return /^(various artists|various|va)$/.test(normalizedArtist) ? 'various' : normalizedArtist;
}

function matchKey(artist, title) {
  const normalizedArtist = canonicalizeVarious(normalize(stripArtistDisambiguation(artist), true));
  return `${normalizedArtist}|${normalize(title)}`;
}

// A key with an empty half matches everything that also normalized down to
// nothing, which is exactly the collision the \p{L}/\p{N} fix above was
// added to prevent -- so it's dropped rather than looked up.
function isUsableKey(key) {
  const bar = key.indexOf('|');
  return bar > 0 && bar < key.length - 1;
}

const TRAILING_PARENTHETICAL = /\s*[\(\[][^\)\]]*[\)\]]\s*$/;

// "Idealistic (A-Trak Remix)" -> "Idealistic". Returns '' when there was
// nothing to strip, so callers can skip the rule entirely rather than
// re-testing the key they already tried.
function stripTrailingParenthetical(title) {
  const stripped = title.replace(TRAILING_PARENTHETICAL, '').trim();
  return stripped && stripped !== title ? stripped : '';
}

// Discogs writes bilingual titles as "Latin Title = Native Title" (and
// occasionally chains three) -- extremely common on Japanese, Russian and
// Chinese pressings, where whatcd will only ever have had one of the two
// spellings typed into it. Indexing both halves is worth 2,411 matches to
// the *unchanged* exact rule against the masters dump alone.
function splitBilingualTitle(title) {
  return title.split(/\s+=\s+/).map((s) => s.trim()).filter(Boolean);
}

// whatcd sometimes keeps a whole credit in one artist row ("Bob Marley &
// The Wailers") where Discogs files the record under the lead artist
// alone. Split on "&" only, never on the word "and" -- "Belle and
// Sebastian" and "Godspeed You! Black Emperor" are single acts, and
// splitting them would invent keys for artists that don't exist.
function splitAmpersandArtist(name) {
  if (!name.includes('&')) return [];
  return name
    .split('&')
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

// Catalogue numbers are precise identifiers, not free text -- "SK 032",
// "SK-032", and "SK032" are the same catalogue number, so inter-token
// separators are dropped entirely rather than collapsed to a space the
// way normalize() treats word text.
function normalizeCatno(catno) {
  if (!catno) return '';
  return catno.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Only catalogue numbers distinctive enough to mean something on their own
// get indexed. "1", "001", "CD", "LP" sit on thousands of unrelated
// records across every label that ever pressed vinyl, and indexing them
// would leave the label check below as the only thing standing between us
// and a wrong match.
function isDistinctiveCatno(normalized) {
  if (normalized.length < 5) return false;
  if (/[A-Z]/.test(normalized) && /[0-9]/.test(normalized)) return true;
  return normalized.length >= 7;
}

// whatcd and Discogs almost never write a label name identically:
// "Beggars Banquet" vs "Beggars Banquet Records", "Ki/oon" vs "Ki/oon
// Music", "Bruton Music" vs "Bruton Music Library", "Sinedin" vs "Sinedín
// Music". The old (label, catno) composite key demanded exact equality
// and threw the whole tier away for all of those -- of a sample of
// unmatched releases carrying both fields, checked against Discogs by
// catalogue number, the label text differed on more than half.
//
// Requiring one name to *contain* the other keeps the check meaningful
// while tolerating the suffix noise. A catalogue number is never accepted
// with no label agreement at all -- that check is what makes this tier
// safe, and dropping it is what would make catno matching dangerous.
function labelRelation(whatcdLabel, discogsLabel) {
  const a = normalize(whatcdLabel);
  const b = normalize(discogsLabel);
  if (!a || !b) return null;
  if (a === b) return 'exact';
  if (a.includes(b) || b.includes(a)) return 'loose';
  return null;
}

// Compilation series whose name is reused by dozens of unrelated records.
// "various|dj kicks" alone covers 46 different whatcd releases, so a hit
// on it says nothing about which one we're actually looking at. Titles
// this generic are the only real false-positive risk in the "various"
// rule -- 98,299 of the 100,829 compilation-shaped releases have a title
// no other release shares.
const GENERIC_COMPILATION_TITLES = new Set([
  'dj kicks',
  'greatest hits',
  'best of',
  'the best of',
  'remixes',
  'untitled',
  'unknown',
  'late night tales',
  'back to mine',
  'love songs',
  'various artists',
  'compilation',
  'sampler',
  'singles',
  'collection',
  'hits',
  'demo',
  'live',
  'promo',
  'mixtape',
  'ep',
]);

// whatcd credits every contributing artist on a compilation with
// importance = 1; Discogs files the same record under "Various". Matching
// picks whatcd's alphabetically-first contributor, so "Bedrock|trainspotting"
// gets looked up when the dump holds "various|trainspotting" -- which is
// why compilations were the single largest unmatched population (100,829
// releases, against only 19,934 compilation-shaped releases matched).
function isCompilationShaped(row) {
  return row.main_artist_count >= 4 || row.release_type === 7;
}

// Only ever applied to the fuzzy rules. Measured against the 20260801
// masters dump: even an exact artist|title match disagrees with the
// master's year by more than four years 6.6% of the time -- reissues,
// anthologies and compilations of older material are legitimately far
// apart -- so a tight guard would reject real matches at a meaningful
// rate. A 15-year window leaves those alone while still throwing out the
// obvious nonsense (a 2013 release matching a 1985 master of the same
// title, which is what an over-generic title looks like when it goes
// wrong).
const FUZZY_MAX_YEAR_GAP = 15;

function yearPlausible(releaseYear, candidates) {
  if (!releaseYear) return true;
  const known = candidates.map((c) => c.year).filter((y) => y);
  if (known.length === 0) return true;
  return known.some((y) => Math.abs(y - releaseYear) <= FUZZY_MAX_YEAR_GAP);
}

// Every way we know of to turn one whatcd release into a key the Discogs
// index might hold, in strict confidence order. The first rule to find a
// candidate wins and its tag is what gets written, so a fuzzy rule can
// never claim a release a more exact rule could have matched.
//
// The percentage on each rule is its year-agreement rate, measured over
// its matches against the 20260801 masters dump: the share whose whatcd
// year lands within four years of the master's own year. Exact
// artist|title scores 93.4%, so that -- not 100% -- is the bar to read
// these against.
//
// `index`  which of the two indexes buildReleasesIndex returns to probe.
// `fuzzy`  subject to the year guard above, and tagged so it can be undone.
// `filter` optional extra proof required of a candidate before accepting it.
const MATCH_RULES = [
  {
    // 93.4% -- the original tier 1, unchanged in intent.
    rule: 'exact',
    suffix: '',
    index: 'title',
    fuzzy: false,
    keys: (r) => [matchKey(r.artist_name, r.release_name)],
  },
  {
    // 92.6-96.5% -- at or above the exact rule's own precision. whatcd
    // stores the canonical artist in artists.name and the name actually
    // credited on the release in artist_aliases; Discogs stores the exact
    // same split as <name> and <anv>. Only the canonical halves were ever
    // being compared, so Smog/Bill Callahan, Dinosaur L/Arthur Russell and
    // KoЯn/Korn all silently failed to match.
    rule: 'alias',
    suffix: '-alias',
    index: 'title',
    fuzzy: false,
    keys: (r) => r.aliases.map((a) => matchKey(a, r.release_name)),
  },
  {
    // 87.1% -- small (a few hundred), but the failures are cheap to reason
    // about: the title still has to match exactly.
    rule: 'ampsplit',
    suffix: '-ampsplit',
    index: 'title',
    fuzzy: false,
    keys: (r) => splitAmpersandArtist(r.artist_name).map((a) => matchKey(a, r.release_name)),
  },
  {
    // Catalogue number plus a label-name agreement. Placed above the fuzzy
    // title rules because a catalogue number identifies a physical record
    // rather than resembling one.
    rule: 'catno',
    suffix: '-catno',
    index: 'catno',
    fuzzy: false,
    keys: (r) => {
      if (!r.record_label || !r.catalogue_number) return [];
      const normalized = normalizeCatno(r.catalogue_number);
      return isDistinctiveCatno(normalized) ? [normalized] : [];
    },
    filter: (candidates, r) => candidates.filter((c) => labelRelation(r.record_label, c.label) !== null),
  },
  {
    // 85.6% -- the largest single win available, and the reason
    // compilations were so badly covered. Gated on a distinctive title.
    rule: 'various',
    suffix: '-various',
    index: 'title',
    fuzzy: true,
    keys: (r) => {
      if (!isCompilationShaped(r)) return [];
      const title = normalize(r.release_name);
      if (!title || GENERIC_COMPILATION_TITLES.has(title)) return [];
      return [`various|${title}`];
    },
  },
  {
    // 82.6% -- the loosest rule here, and tagged accordingly. Matches
    // "Idealistic (A-Trak Remix)" to the master for "Idealistic": a
    // different record, but the same artist and the same work, which is
    // the same trade the masters dump already makes by pooling videos
    // across pressings.
    rule: 'paren',
    suffix: '-paren',
    index: 'title',
    fuzzy: true,
    keys: (r) => {
      const stripped = stripTrailingParenthetical(r.release_name);
      return stripped ? [matchKey(r.artist_name, stripped)] : [];
    },
  },
];

const RULE_RANK = new Map(MATCH_RULES.map((r, i) => [r.rule, i]));

function tagFor(rule, base) {
  return `${base}${MATCH_RULES.find((r) => r.rule === rule).suffix}`;
}

// Resolves one whatcd release against a pair of indexes by walking
// MATCH_RULES in order. Returns the winning rule plus the candidate list
// it found, or null. Shared by both dumps so the ladder can't drift apart
// between them.
function resolveMatch(row, indexes) {
  for (const rule of MATCH_RULES) {
    const index = indexes[rule.index];
    if (!index) continue;
    for (const key of rule.keys(row)) {
      if (!key || (rule.index === 'title' && !isUsableKey(key))) continue;
      let candidates = index.get(key);
      if (!candidates || candidates.length === 0) continue;
      if (rule.filter) {
        candidates = rule.filter(candidates, row);
        if (candidates.length === 0) continue;
      }
      if (rule.fuzzy && !yearPlausible(row.release_year, candidates)) continue;
      return { rule: rule.rule, candidates };
    }
  }
  return null;
}

// Streams the gunzipped dump and yields each top-level `<tag ...>...</tag>`
// block as a string (release or master, per caller). Buffers only up to
// one block's worth of unconsumed text at a time (plus whatever's
// mid-flight in a single chunk) rather than ever holding the full
// multi-GB file -- blocks are a few hundred bytes to a few KB each, so
// this stays small throughout. Uses StringDecoder (not chunk.toString())
// so a multi-byte UTF-8 character split across two chunks doesn't get
// corrupted at the boundary.
async function* xmlBlocks(source, tag) {
  const openTag = `<${tag} `;
  const closeTag = `</${tag}>`;
  const gunzip = zlib.createGunzip();
  let src;
  if (/^https?:\/\//i.test(source)) {
    // Streams straight from the network into gunzip -- the compressed
    // dump is never written to disk anywhere. Readable.fromWeb bridges
    // fetch()'s Web ReadableStream body into a Node stream so it can be
    // piped like any other source.
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
  // propagates up to the caller, which decides whether to retry (for a
  // URL source) or just accept partial progress (for a local file, where
  // re-reading it would hit the identical truncation again).
  for await (const chunk of gunzip) {
    buffer += decoder.write(chunk);
    let start;
    while ((start = buffer.indexOf(openTag)) !== -1) {
      const end = buffer.indexOf(closeTag, start);
      if (end === -1) break; // block not fully buffered yet -- wait for more data
      yield buffer.slice(start, end + closeTag.length);
      buffer = buffer.slice(end + closeTag.length);
    }
  }
}

// Shared by extractRelease/extractMaster -- both wrap a <videos> element
// with the identical <video src=... embed=...><title>...</title></video>
// shape.
function parseVideos(videosInner) {
  const videos = [];
  const videoEntryRe = /<video\s+([^>]*)>([\s\S]*?)<\/video>/g;
  let vm;
  while ((vm = videoEntryRe.exec(videosInner))) {
    const attrs = vm[1];
    const src = attrs.match(/src="([^"]*)"/)?.[1];
    if (!src || !YOUTUBE_ID_RE.test(src)) continue;
    const embed = attrs.match(/embed="([^"]*)"/)?.[1];
    if (embed === 'false') continue; // Discogs itself flags this as non-embeddable
    const title = vm[2].match(/<title>([^<]*)<\/title>/)?.[1];
    videos.push({ url: copy(decodeXmlEntities(src)), title: copy(title ? decodeXmlEntities(title) : 'Video') });
    if (videos.length >= 5) break; // matches the live lookup's cap (discogsRelease.ts)
  }
  return videos;
}

const MAX_VIDEOS = 5;

function youtubeId(url) {
  return url.match(YOUTUBE_ID_RE)?.[1] ?? url;
}

// Appends videos without ever displacing what's already there, deduped by
// YouTube id rather than by URL (the same video appears as youtu.be/... and
// watch?v=... across different Discogs submissions).
function mergeVideos(existing, extra) {
  const seen = new Set(existing.map((v) => youtubeId(v.url)));
  const merged = existing.slice();
  for (const video of extra) {
    if (merged.length >= MAX_VIDEOS) break;
    const id = youtubeId(video.url);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(video);
  }
  return merged;
}

// Discogs stores two names per credited artist: <name> is the canonical
// artist and <anv> ("artist name variation") is how they were credited on
// this particular record -- the exact mirror of whatcd's artist_aliases.
// Indexing both is worth 4,157 matches against the masters dump.
//
// A multi-artist release additionally gets its joined form indexed,
// because whatcd sometimes keeps the entire credit in a single artist row
// ("Christy Azuma & Uppers International") where Discogs splits it in two.
function extractArtistVariants(artistsInner) {
  const names = [];
  const variants = new Set();
  for (const m of artistsInner.matchAll(/<artist>([\s\S]*?)<\/artist>/g)) {
    const name = m[1].match(/<name>([^<]*)<\/name>/)?.[1];
    const anv = m[1].match(/<anv>([^<]*)<\/anv>/)?.[1];
    if (name) {
      const c = copy(decodeXmlEntities(name));
      names.push(c);
      variants.add(c);
    }
    if (anv) variants.add(copy(decodeXmlEntities(anv)));
  }
  if (names.length > 1) variants.add(names.join(' & '));
  return { names, variants: [...variants] };
}

// Every spelling of a dump entry's title worth indexing: the title itself,
// each half of a bilingual "A = B" title, and each of those with a
// trailing parenthetical stripped (the edition suffix sits on the Discogs
// side about as often as it sits on whatcd's).
function extractTitleVariants(title) {
  const variants = new Set([title]);
  for (const half of splitBilingualTitle(title)) variants.add(half);
  for (const v of [...variants]) {
    const stripped = stripTrailingParenthetical(v);
    if (stripped) variants.add(stripped);
  }
  return [...variants];
}

function extractRelease(block) {
  const idMatch = block.match(/<release id="(\d+)"/);
  if (!idMatch) return null;

  const videosMatch = block.match(/<videos>([\s\S]*?)<\/videos>/);
  if (!videosMatch) return null; // no videos at all -- cheap early exit, most releases stop here
  const videos = parseVideos(videosMatch[1]);
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
  if (!artistsMatch) return null;
  const { names, variants } = extractArtistVariants(artistsMatch[1]);
  if (names.length === 0) return null;

  // <labels><label name="Svek" catno="SK032" id="5"/></labels> -- a
  // release can carry more than one (co-releases, or a different catno
  // per format), so every (name, catno) pair gets its own entry in the
  // catalogue-number index (see buildReleasesIndex).
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
  // The releases dump names each release's canonical work outright, which
  // is what makes enrichExactMatchesFromMasters an exact operation rather
  // than a second guess at matching.
  const masterId = Number(block.match(/<master_id[^>]*>(\d+)<\/master_id>/)?.[1]) || null;

  return {
    discogsId: Number(idMatch[1]),
    titleVariants: extractTitleVariants(copy(decodeXmlEntities(title))),
    artistVariants: variants,
    labels,
    year,
    masterId,
    videos,
  };
}

// Masters have no <tracklist>, so <videos> alone is the title cutoff; no
// <labels> either -- catalogue numbers are a per-pressing (release-level)
// concept, not a per-work one.
function extractMaster(block) {
  const idMatch = block.match(/<master id="(\d+)"/);
  if (!idMatch) return null;

  const videosMatch = block.match(/<videos>([\s\S]*?)<\/videos>/);
  if (!videosMatch) return null;
  const videos = parseVideos(videosMatch[1]);
  if (videos.length === 0) return null;

  const cutoff = block.indexOf('<videos>');
  const title = block.slice(0, cutoff === -1 ? block.length : cutoff).match(/<title>([^<]*)<\/title>/)?.[1];
  if (!title) return null;

  const artistsMatch = block.match(/<artists>([\s\S]*?)<\/artists>/);
  if (!artistsMatch) return null;
  const { names, variants } = extractArtistVariants(artistsMatch[1]);
  if (names.length === 0) return null;

  const year = Number(block.match(/<year>(\d{4})/)?.[1]) || null;

  return {
    masterId: Number(idMatch[1]),
    titleVariants: extractTitleVariants(copy(decodeXmlEntities(title))),
    artistVariants: variants,
    year,
    videos,
  };
}

// A dropped connection partway through a large streamed fetch is a real,
// observed failure mode (hit it in production: died after 175s/6.4M
// releases with a socket-closed error). Range requests aren't honored by
// data.discogs.com (confirmed separately), so there's no way to resume
// from where it left off -- the only option is restarting the fetch from
// byte 0. Only applies to URL sources -- a truncated local file would hit
// the identical cutoff again, so that case just accepts partial progress
// immediately.
const MAX_FETCH_RETRIES = 5;

function logProgress(what, scanned, withVideos, extra, startedAt) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1024 / 1024).toFixed(0);
  const heap = (mem.heapUsed / 1024 / 1024).toFixed(0);
  console.log(
    `  scanned ${scanned.toLocaleString()} ${what} (${withVideos.toLocaleString()} with usable video)${extra} -- ${elapsed}s -- rss ${rss}MB heap ${heap}MB`,
  );
}

// Wraps a streaming pass in the retry/partial-progress policy described at
// MAX_FETCH_RETRIES. `onBlock` is called for every block; whatever it
// accumulated survives a give-up.
async function streamWithRetry(source, tag, label, onBlock) {
  const isUrl = /^https?:\/\//i.test(source);
  let attempt = 0;
  while (true) {
    try {
      for await (const block of xmlBlocks(source, tag)) onBlock(block);
      return;
    } catch (err) {
      attempt++;
      console.warn(`Warning: ${label} stream ended early (${err?.message ?? err}).`);
      if (!isUrl) {
        console.warn('Local file source -- not retrying (would hit the same cutoff). Using everything scanned so far.');
        return;
      }
      if (attempt > MAX_FETCH_RETRIES) {
        console.warn(`Giving up after ${MAX_FETCH_RETRIES} retries. Using everything scanned so far.`);
        return;
      }
      console.warn(`Restarting the fetch from the beginning (attempt ${attempt}/${MAX_FETCH_RETRIES})...`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function buildReleasesIndex(source) {
  const title = new Map(); // artist|title -> [{ discogsId, year, videos, masterId }]
  const catno = new Map(); // normalized catno -> [{ discogsId, year, videos, masterId, label }]
  let scanned = 0;
  let withVideos = 0;
  const startedAt = Date.now();

  await streamWithRetry(source, 'release', 'releases dump', (block) => {
    scanned++;
    if (scanned % 200_000 === 0) logProgress('releases', scanned, withVideos, '', startedAt);

    const extracted = extractRelease(block);
    if (!extracted) return;
    withVideos++;

    const entry = {
      discogsId: extracted.discogsId,
      year: extracted.year,
      videos: extracted.videos,
      masterId: extracted.masterId,
    };
    for (const artist of extracted.artistVariants) {
      for (const t of extracted.titleVariants) {
        const key = matchKey(artist, t);
        if (!isUsableKey(key)) continue;
        const bucket = title.get(key);
        if (bucket) bucket.push(entry);
        else title.set(key, [entry]);
      }
    }
    // Keyed on the catalogue number alone, with the label carried on the
    // entry so labelRelation() can do the agreement check at lookup time.
    // The old composite (label, catno) key could only ever match when both
    // sides spelled the label identically, which they mostly don't.
    for (const label of extracted.labels) {
      const key = normalizeCatno(label.catno);
      if (!isDistinctiveCatno(key)) continue;
      const withLabel = { ...entry, label: label.name };
      const bucket = catno.get(key);
      if (bucket) bucket.push(withLabel);
      else catno.set(key, [withLabel]);
    }
  });

  console.log(
    `Releases index built: ${scanned.toLocaleString()} releases scanned, ${withVideos.toLocaleString()} had a usable YouTube video, ` +
      `${title.size.toLocaleString()} distinct artist|title keys, ${catno.size.toLocaleString()} distinct catalogue numbers.`,
  );
  return { title, catno };
}

// Unlike buildReleasesIndex, this never retains an index of the whole
// dump -- `wantedKeys` is the small, known-in-advance set of keys for
// whatcd releases that are *still* unmatched, computed from the local DB
// before this ever streams a byte. Every master block gets parsed
// (unavoidable -- the file has to be read once regardless), but a block
// whose keys aren't wanted is discarded immediately and never retained
// anywhere. Peak memory is bounded by the wanted-key set plus however
// many actual hits are found, not by the size of Discogs' entire master
// catalog.
//
// `wantedMasterIds` rides along on the same pass: those are the masters of
// releases already matched *exactly*, whose videos are wanted for
// enrichment rather than for matching. Collecting them here costs one set
// lookup per block and saves a second full stream of the dump.
async function buildMastersMatches(source, wantedKeys, wantedMasterIds) {
  const matched = new Map(); // key -> [{ masterId, year, videos }]
  const forEnrichment = new Map(); // masterId -> videos
  let scanned = 0;
  let withVideos = 0;
  const startedAt = Date.now();

  await streamWithRetry(source, 'master', 'masters dump', (block) => {
    scanned++;
    if (scanned % 100_000 === 0) {
      logProgress('masters', scanned, withVideos, `, ${matched.size.toLocaleString()} matched keys so far`, startedAt);
    }

    const extracted = extractMaster(block);
    if (!extracted) return;
    withVideos++;

    if (wantedMasterIds.has(extracted.masterId)) {
      forEnrichment.set(extracted.masterId, extracted.videos);
    }

    const entry = { masterId: extracted.masterId, year: extracted.year, videos: extracted.videos };
    const seen = new Set();
    for (const artist of extracted.artistVariants) {
      for (const t of extracted.titleVariants) {
        const key = matchKey(artist, t);
        if (!wantedKeys.has(key) || seen.has(key)) continue;
        seen.add(key);
        const bucket = matched.get(key);
        if (bucket) bucket.push(entry);
        else matched.set(key, [entry]);
      }
    }
  });

  console.log(
    `Masters scan done: ${scanned.toLocaleString()} masters scanned, ${withVideos.toLocaleString()} had a usable YouTube video, ` +
      `${matched.size.toLocaleString()} of ${wantedKeys.size.toLocaleString()} wanted keys matched, ` +
      `${forEnrichment.size.toLocaleString()} of ${wantedMasterIds.size.toLocaleString()} enrichment masters found.`,
  );
  return { matched, forEnrichment };
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

function ensureColumns(db) {
  const cols = db.prepare('PRAGMA table_info(release_extras)').all();
  const have = new Set(cols.map((c) => c.name));
  if (!have.has('source')) db.exec('ALTER TABLE release_extras ADD COLUMN source TEXT');
  // Recorded by the releases tier so the masters tier can pool a release's
  // own master videos onto it without having to match anything again.
  if (!have.has('discogs_master_id')) db.exec('ALTER TABLE release_extras ADD COLUMN discogs_master_id INTEGER');
}

// Loads every alias whatcd knows for an artist, not just the one credited
// on a given release. Aliases identical to the canonical name are skipped
// (that's the overwhelming majority of the ~1M rows -- most artists have
// exactly one "alias", their own name), and the per-artist list is capped
// so a handful of artists with 100+ aliases can't blow the key count up.
const MAX_ALIASES_PER_ARTIST = 12;

function loadAliases(db) {
  const byArtist = new Map();
  for (const row of db
    .prepare(
      `SELECT al.artist_id, al.name
       FROM artist_aliases al
       JOIN artists a ON a.id = al.artist_id
       WHERE al.name <> a.name`,
    )
    .iterate()) {
    const bucket = byArtist.get(row.artist_id);
    if (bucket) {
      if (bucket.length < MAX_ALIASES_PER_ARTIST) bucket.push(row.name);
    } else {
      byArtist.set(row.artist_id, [row.name]);
    }
  }
  console.log(`${byArtist.size.toLocaleString()} artists have an alias distinct from their canonical name.`);
  return byArtist;
}

// The one place a release_extras row gets written, so the confidence
// ordering is structural rather than a property of where the call sites
// happen to sit. A release already claimed by a better-ranked rule in this
// run is left alone; rows from an earlier dump are always replaced, since
// that's the whole point of re-running against a newer dump.
function makeWriter(db) {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO release_extras (release_id, discogs_url, videos, fetched_at, source, discogs_master_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  const rankByRelease = new Map();
  // `base` is which dump the match came from -- SOURCE_TAG for the releases
  // dump, MASTER_SOURCE_TAG for the masters dump -- so the tag records both
  // halves of the provenance: which dump, and which rule fired. A masters
  // exact match therefore still reads "bulk-YYYYMMDD-master", exactly as it
  // did before the rule ladder existed.
  return function write(releaseId, rule, base, discogsUrl, videos, masterId) {
    const rank = RULE_RANK.get(rule);
    const existing = rankByRelease.get(releaseId);
    if (existing !== undefined && existing <= rank) return false;
    rankByRelease.set(releaseId, rank);
    insert.run(releaseId, discogsUrl, JSON.stringify(videos), now, tagFor(rule, base), masterId ?? null);
    return true;
  };
}

// Streams the whatcd side of the match: one row per release, carrying the
// main artist plus everything MATCH_RULES needs to decide. Rows arrive
// pre-sorted by (release_id, artist name), so the first artist seen per
// release is the "one main artist, alphabetically first if several" the
// live lookup uses too (api/src/routes/torrents.ts) -- and because they're
// contiguous, the remaining rows for the same release can be counted on
// the way past to give isCompilationShaped() its artist count for free.
//
// Streamed via .iterate() rather than .all(): by the time this runs the
// in-memory Discogs index (millions of entries) is already resident, and
// materializing this whole join as a second multi-million-row array on top
// of it is what pushed the process OOM in production.
function loadWhatcdReleases(db, aliasesByArtist, { onlyUnmatched }) {
  const releases = new Map();
  const filter = onlyUnmatched
    ? // Includes rows that exist but hold no video: a release the live
      // /extras lookup once probed and came back empty on used to be
      // excluded from the masters tier forever, because the tier tested
      // only for the row's existence. That silently stranded 8,432
      // releases.
      `LEFT JOIN release_extras re ON re.release_id = r.id
       WHERE r.category_id = 1 AND (re.release_id IS NULL OR re.videos IS NULL OR re.videos = '[]')`
    : `WHERE r.category_id = 1`;
  for (const row of db
    .prepare(
      `SELECT r.id AS release_id, r.name AS release_name, r.year AS release_year,
              r.release_type AS release_type,
              r.record_label AS record_label, r.catalogue_number AS catalogue_number,
              ra.artist_id AS artist_id, a.name AS artist_name
       FROM releases r
       JOIN release_artists ra ON ra.release_id = r.id AND ra.importance = 1
       JOIN artists a ON a.id = ra.artist_id
       ${filter}
       ORDER BY r.id, a.name COLLATE NOCASE ASC`,
    )
    .iterate()) {
    const existing = releases.get(row.release_id);
    if (existing) {
      existing.main_artist_count++;
      continue;
    }
    row.main_artist_count = 1;
    row.aliases = aliasesByArtist.get(row.artist_id) ?? [];
    releases.set(row.release_id, row);
  }
  return releases;
}

function summarize(label, counts, base) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`${label}: ${total.toLocaleString()} releases`);
  for (const rule of MATCH_RULES) {
    const n = counts[rule.rule] ?? 0;
    if (n > 0) {
      console.log(`  ${padLeft(n.toLocaleString(), 9)}  ${padRight(rule.rule, 9)} source="${tagFor(rule.rule, base)}"`);
    }
  }
  return total;
}

// The releases dump: every rule in MATCH_RULES, against the full index.
async function runReleasesTiers(db, write, aliasesByArtist) {
  console.log(`Reading releases dump: ${releasesDumpSource}`);
  const indexes = await buildReleasesIndex(releasesDumpSource);

  const releases = loadWhatcdReleases(db, aliasesByArtist, { onlyUnmatched: false });
  console.log(`${releases.size.toLocaleString()} music releases have a main artist to match against.`);

  const counts = {};
  db.exec('BEGIN');
  try {
    for (const row of releases.values()) {
      const match = resolveMatch(row, indexes);
      if (!match) continue;
      const best = pickBestCandidate(match.candidates, row.release_year);
      if (
        write(
          row.release_id,
          match.rule,
          SOURCE_TAG,
          `https://www.discogs.com/release/${best.discogsId}`,
          best.videos,
          best.masterId,
        )
      ) {
        counts[match.rule] = (counts[match.rule] ?? 0) + 1;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  summarize('Releases dump matched', counts, SOURCE_TAG);
}

// The masters dump: the same rules, scoped to whatever the releases dump
// left without a usable video. Its own transaction, independent of
// runReleasesTiers's.
async function runMastersTier(db, write, aliasesByArtist) {
  const releases = loadWhatcdReleases(db, aliasesByArtist, { onlyUnmatched: true });
  console.log(`${releases.size.toLocaleString()} music releases still have no video -- trying the masters dump.`);

  // Masters carry no catalogue numbers, so the catno rule contributes
  // nothing here; passing no catno index makes resolveMatch skip it.
  const wantedKeys = new Set();
  for (const row of releases.values()) {
    for (const rule of MATCH_RULES) {
      if (rule.index !== 'title') continue;
      for (const key of rule.keys(row)) if (key && isUsableKey(key)) wantedKeys.add(key);
    }
  }

  // Exactly-matched releases whose pressing carried fewer than the cap:
  // their master's videos are wanted for enrichment, not for matching.
  const enrichmentTargets = new Map(); // masterId -> [{ releaseId, videos }]
  for (const row of db
    .prepare(
      `SELECT release_id, videos, discogs_master_id
       FROM release_extras
       WHERE discogs_master_id IS NOT NULL AND videos IS NOT NULL AND videos <> '[]'`,
    )
    .iterate()) {
    let videos;
    try {
      videos = JSON.parse(row.videos);
    } catch {
      continue;
    }
    if (!Array.isArray(videos) || videos.length === 0 || videos.length >= MAX_VIDEOS) continue;
    const bucket = enrichmentTargets.get(row.discogs_master_id);
    if (bucket) bucket.push({ releaseId: row.release_id, videos });
    else enrichmentTargets.set(row.discogs_master_id, [{ releaseId: row.release_id, videos }]);
  }
  console.log(
    `${wantedKeys.size.toLocaleString()} wanted keys; ` +
      `${enrichmentTargets.size.toLocaleString()} masters wanted to top up already-matched releases.`,
  );

  if (wantedKeys.size === 0 && enrichmentTargets.size === 0) {
    console.log('Nothing left to match or enrich -- skipping the masters dump entirely.');
    return;
  }

  console.log(`Reading masters dump: ${mastersDumpSource}`);
  const { matched, forEnrichment } = await buildMastersMatches(
    mastersDumpSource,
    wantedKeys,
    new Set(enrichmentTargets.keys()),
  );

  const counts = {};
  db.exec('BEGIN');
  try {
    for (const row of releases.values()) {
      const match = resolveMatch(row, { title: matched });
      if (!match) continue;
      const best = pickBestCandidate(match.candidates, row.release_year);
      if (
        write(row.release_id, match.rule, MASTER_SOURCE_TAG, `https://www.discogs.com/master/${best.masterId}`, best.videos, null)
      ) {
        counts[match.rule] = (counts[match.rule] ?? 0) + 1;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  summarize('Masters dump matched', counts, MASTER_SOURCE_TAG);

  enrichExactMatchesFromMasters(db, enrichmentTargets, forEnrichment);
}

// Tops up releases that already have a confident match but only one or two
// videos on the specific pressing, using the videos pooled onto that
// release's own master. Not a match -- the releases dump told us the master
// id outright -- so this only ever appends, never replaces, and never
// touches the row's source tag or its discogs_url.
//
// Worth doing because what.tv prunes a dead video via
// POST /api/tv/:id/video-dead and a release whose only video dies leaves
// the pool entirely. Roughly a third of matched releases ride on exactly
// one video.
function enrichExactMatchesFromMasters(db, targets, forEnrichment) {
  if (forEnrichment.size === 0) return;
  const update = db.prepare('UPDATE release_extras SET videos = ? WHERE release_id = ?');
  let enriched = 0;
  let videosAdded = 0;
  db.exec('BEGIN');
  try {
    for (const [masterId, extra] of forEnrichment) {
      for (const { releaseId, videos } of targets.get(masterId) ?? []) {
        const merged = mergeVideos(videos, extra);
        if (merged.length === videos.length) continue;
        update.run(JSON.stringify(merged), releaseId);
        enriched++;
        videosAdded += merged.length - videos.length;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log(
    `Enriched ${enriched.toLocaleString()} already-matched releases with ${videosAdded.toLocaleString()} extra videos from their own masters.`,
  );
}

// Everything the end-of-run report compares, taken once before any writes
// and once after. Counting the videos themselves (rather than just the
// rows) is what makes the enrichment pass visible -- it adds no releases
// at all, only videos to releases that already had one.
function coverageSnapshot(db) {
  const totals = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM releases WHERE category_id = 1) AS music_releases,
         (SELECT COUNT(*) FROM releases r
            JOIN release_extras re ON re.release_id = r.id
           WHERE r.category_id = 1 AND re.videos IS NOT NULL AND re.videos <> '[]') AS with_videos`,
    )
    .get();

  const bySource = new Map();
  let videos = 0;
  for (const row of db
    .prepare(`SELECT source, videos FROM release_extras WHERE videos IS NOT NULL AND videos <> '[]'`)
    .iterate()) {
    let n = 0;
    try {
      const parsed = JSON.parse(row.videos);
      if (Array.isArray(parsed)) n = parsed.length;
    } catch {
      continue;
    }
    videos += n;
    const key = row.source ?? '(live lookup)';
    bySource.set(key, (bySource.get(key) ?? 0) + 1);
  }

  return { musicReleases: totals.music_releases, withVideos: totals.with_videos, videos, bySource };
}

function delta(before, after) {
  const d = after - before;
  const pct = before > 0 ? ` (${d >= 0 ? '+' : ''}${((100 * d) / before).toFixed(1)}%)` : '';
  return `${d >= 0 ? '+' : ''}${d.toLocaleString()}${pct}`;
}

const padLeft = (s, n) => String(s).padStart(n);
const padRight = (s, n) => String(s).padEnd(n);

function reportRow(label, before, after, change) {
  console.log(padRight(label, 24) + padLeft(before, 13) + padLeft(after, 13) + padLeft(change, 20));
}

function reportCoverage(before, after) {
  const shareBefore = (100 * before.withVideos) / before.musicReleases;
  const shareAfter = (100 * after.withVideos) / after.musicReleases;
  const shareChange = shareAfter - shareBefore;
  const unmatchedBefore = before.musicReleases - before.withVideos;
  const unmatchedAfter = after.musicReleases - after.withVideos;

  console.log('\n================ Coverage ================');
  reportRow('', 'before', 'after', 'change');
  reportRow(
    'releases with video',
    before.withVideos.toLocaleString(),
    after.withVideos.toLocaleString(),
    delta(before.withVideos, after.withVideos),
  );
  reportRow(
    'share of catalogue',
    `${shareBefore.toFixed(1)}%`,
    `${shareAfter.toFixed(1)}%`,
    `${shareChange >= 0 ? '+' : ''}${shareChange.toFixed(1)}pp`,
  );
  reportRow(
    'videos on file',
    before.videos.toLocaleString(),
    after.videos.toLocaleString(),
    delta(before.videos, after.videos),
  );
  reportRow(
    'still unmatched',
    unmatchedBefore.toLocaleString(),
    unmatchedAfter.toLocaleString(),
    delta(unmatchedBefore, unmatchedAfter),
  );

  console.log('\n================ By source tag ================');
  const sources = [...new Set([...before.bySource.keys(), ...after.bySource.keys()])].sort();
  console.log(padRight('source', 34) + padLeft('before', 12) + padLeft('after', 12) + padLeft('change', 14));
  for (const source of sources) {
    const b = before.bySource.get(source) ?? 0;
    const a = after.bySource.get(source) ?? 0;
    const d = a - b;
    console.log(
      padRight(source.slice(0, 33), 34) +
        padLeft(b.toLocaleString(), 12) +
        padLeft(a.toLocaleString(), 12) +
        padLeft(`${d >= 0 ? '+' : ''}${d.toLocaleString()}`, 14),
    );
  }
  console.log();
}

// Only ever asked when stdin is a terminal. The production wrapper starts
// this detached under nohup, where there is nobody to answer and a prompt
// would block the run forever -- that path passes --rerun instead.
async function askRerun() {
  if (!process.stdin.isTTY) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Re-stream the releases dump anyway? [y/N] ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function main() {
  console.log(`Writing to: ${DB_PATH}`);
  const db = new DatabaseSync(DB_PATH);
  ensureColumns(db);

  const before = coverageSnapshot(db);
  console.log(
    `Starting from ${before.withVideos.toLocaleString()} of ${before.musicReleases.toLocaleString()} music releases with a video ` +
      `(${((100 * before.withVideos) / before.musicReleases).toFixed(1)}%), ${before.videos.toLocaleString()} videos on file.`,
  );

  const write = makeWriter(db);
  const aliasesByArtist = loadAliases(db);

  const alreadyImported = db.prepare('SELECT 1 FROM release_extras WHERE source LIKE ? LIMIT 1').get(`${SOURCE_TAG}%`);
  let runReleases = true;
  if (alreadyImported && !FORCE_RERUN) {
    console.log(`\nrelease_extras already has rows tagged "${SOURCE_TAG}%" -- this dump has been imported before.`);
    console.log('Re-running it only changes anything if the matching rules have changed since.');
    const answer = await askRerun();
    if (answer === null) {
      console.log('Not a terminal, so nothing to ask -- skipping the releases dump. Pass --rerun to force it.');
      runReleases = false;
    } else if (!answer) {
      console.log('Skipping the releases dump.');
      runReleases = false;
    } else {
      console.log('Re-streaming the releases dump.');
    }
  }

  if (runReleases) await runReleasesTiers(db, write, aliasesByArtist);
  await runMastersTier(db, write, aliasesByArtist);

  reportCoverage(before, coverageSnapshot(db));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
