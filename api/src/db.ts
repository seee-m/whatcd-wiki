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

// Single-row lifetime hit counter. Lives in the DB (rather than in-memory,
// like the old daily counter) specifically so it survives deploys/restarts
// -- SQLITE_PATH points at a persistent Fly volume in prod, so this
// naturally carries over between releases.
db.exec(`
  CREATE TABLE IF NOT EXISTS site_visits (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    count INTEGER NOT NULL DEFAULT 0
  )
`);
db.exec(`INSERT OR IGNORE INTO site_visits (id, count) VALUES (1, 0)`);

export type SqlParam = string | number | bigint | null;

export const CATEGORIES = [
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
export const RELEASE_TYPES: Record<number, string> = {
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
