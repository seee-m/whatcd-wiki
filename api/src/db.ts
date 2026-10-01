import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

// Defaults to a location outside any cloud-sync folder (this project lives
// under Dropbox) -- a multi-GB SQLite file actively read by the API can hit
// SQLITE_BUSY from Dropbox's own file watcher, or get evicted to
// cloud-only and stall on read. Override with SQLITE_PATH for hosting.
const DB_PATH = process.env.SQLITE_PATH || path.join(os.homedir(), 'Library/Application Support/whatcd-wiki/whatcd.sqlite');

// Read-write, not read-only -- cover art lookups (see cover.ts) cache their
// result back into release_covers so external providers are only ever hit
// once per release. Everything else the app does is still reads only.
export const db = new DatabaseSync(DB_PATH);

// import.mjs finishes with `PRAGMA journal_mode = DELETE` and nothing set
// it back, so the served database ran in rollback-journal mode: any write
// (e.g. the release_covers/artist_info/release_extras cache-back writes
// below) takes an exclusive lock and fsyncs in that mode, blocking every
// concurrent reader on a single-threaded server. WAL lets that write
// proceed alongside reads. NORMAL trades an fsync per commit for one per
// checkpoint -- the durability at risk is best-effort external-lookup
// caches, all re-derivable, and nothing here is a transaction anyone would
// miss after a power loss.
//
// The Dropbox/SQLITE_BUSY trouble noted in the import script was about a
// database file living *inside* a sync folder; both the dev default above
// and the deployed /data volume are outside one, so WAL is safe in both.
// journal_mode persists in the file; synchronous is per connection.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');

// SQLite's defaults are a ~2MB page cache and no mmap, so every read past
// that went through a read() syscall and a copy. mmap lets queries read
// straight out of the OS page cache instead. It's address space, not
// memory: the kernel still decides what stays resident, so a cap above the
// file size (~4.4GB) is harmless on a 4GB machine. The page cache on top
// is per connection and there is one.
db.exec('PRAGMA mmap_size = 8589934592');
db.exec('PRAGMA cache_size = -65536');

// Missing from databases imported before schema.sql had it. Builds in a few
// seconds over ~840k rows on first boot, then IF NOT EXISTS is a no-op.
// Without it the artist page's similar-artists self-join scans the table.
db.exec('CREATE INDEX IF NOT EXISTS idx_artists_similar_similar ON artists_similar(similar_id)');

// release_covers postdates the original import; create it if this DB was
// built before the feature existed, so an existing install doesn't need a
// full re-import just to pick it up.
db.exec(`
  CREATE TABLE IF NOT EXISTS release_covers (
    release_id INTEGER PRIMARY KEY,
    cover_url TEXT,
    source TEXT,
    fetched_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS artist_info (
    artist_id INTEGER PRIMARY KEY,
    bio TEXT,
    image_url TEXT,
    source TEXT,
    fetched_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS release_extras (
    release_id INTEGER PRIMARY KEY,
    discogs_url TEXT,
    videos TEXT,
    fetched_at TEXT NOT NULL
  )
`);

// User-created shareable release lists -- release_ids is a comma-separated
// list of integers rather than a collage_releases-style join table. Lists
// are small (capped) and never queried by "which lists contain release X",
// so a join table would only add row/index overhead for no benefit.
db.exec(`
  CREATE TABLE IF NOT EXISTS shared_lists (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    category_id INTEGER NOT NULL DEFAULT 0,
    release_ids TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

export type SqlParam = string | number | bigint | null;

const CATEGORIES = [
  { id: 1, name: 'Music', icon: 'music.png' },
  { id: 2, name: 'Applications', icon: 'apps.png' },
  { id: 3, name: 'E-Books', icon: 'ebook.png' },
  { id: 4, name: 'Audiobooks', icon: 'audiobook.png' },
  { id: 5, name: 'E-Learning Videos', icon: 'elearning.png' },
  { id: 6, name: 'Comedy', icon: 'comedy.png' },
  { id: 7, name: 'Comics', icon: 'comics.png' },
] as const;

export function categoryName(id: number): string {
  return CATEGORIES.find((c) => c.id === id)?.name ?? 'Unknown';
}

// The real Gazelle $ReleaseTypes mapping (classes/config.template).
const RELEASE_TYPES: Record<number, string> = {
  1: 'Album',
  3: 'Soundtrack',
  5: 'EP',
  6: 'Anthology',
  7: 'Compilation',
  9: 'Single',
  11: 'Live album',
  13: 'Remix',
  14: 'Bootleg',
  15: 'Interview',
  16: 'Mixtape',
  21: 'Unknown',
};

export function releaseTypeName(id: number): string {
  return RELEASE_TYPES[id] ?? 'Unknown';
}

// Collages have their own, entirely separate category system from
// torrents/releases -- the real Gazelle $CollageCats mapping
// (classes/config.template), 0-indexed. Collages were previously (wrongly)
// labeled with the torrent CATEGORIES above.
export const COLLAGE_CATEGORIES: Record<number, string> = {
  0: 'Personal',
  1: 'Theme',
  2: 'Genre introduction',
  3: 'Discography',
  4: 'Label',
  5: 'Staff picks',
  6: 'Charts',
  7: 'Artists',
};

export function collageCategoryName(id: number): string {
  return COLLAGE_CATEGORIES[id] ?? 'Unknown';
}
