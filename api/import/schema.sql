-- Target SQLite schema for the read-only whatcd archive browser.
-- Built once by import.mjs / import-wiki.mjs from the source MySQL dumps.

CREATE TABLE releases (
  id INTEGER PRIMARY KEY,
  category_id INTEGER,
  name TEXT NOT NULL,
  year INTEGER,
  catalogue_number TEXT,
  record_label TEXT,
  release_type INTEGER,
  time TEXT
);
CREATE INDEX idx_releases_name ON releases(name);
CREATE INDEX idx_releases_category ON releases(category_id);
CREATE INDEX idx_releases_year ON releases(year);

CREATE VIRTUAL TABLE releases_fts USING fts5(name, content='releases', content_rowid='id');

CREATE TABLE artists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE INDEX idx_artists_name ON artists(name);
CREATE VIRTUAL TABLE artists_fts USING fts5(name, content='artists', content_rowid='id');

CREATE TABLE artist_aliases (
  id INTEGER PRIMARY KEY,
  artist_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  redirect INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_artist_aliases_artist ON artist_aliases(artist_id);
CREATE INDEX idx_artist_aliases_name ON artist_aliases(name);

CREATE TABLE release_artists (
  release_id INTEGER NOT NULL,
  artist_id INTEGER NOT NULL,
  alias_id INTEGER NOT NULL,
  importance INTEGER NOT NULL,
  PRIMARY KEY (release_id, artist_id, importance)
);
CREATE INDEX idx_release_artists_artist ON release_artists(artist_id);
CREATE INDEX idx_release_artists_release ON release_artists(release_id);

CREATE TABLE collages (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  num_torrents INTEGER NOT NULL DEFAULT 0,
  category_id INTEGER NOT NULL DEFAULT 1,
  tag_list TEXT NOT NULL DEFAULT '',
  subscribers INTEGER DEFAULT 0,
  updated TEXT
);
CREATE INDEX idx_collages_name ON collages(name);
CREATE VIRTUAL TABLE collages_fts USING fts5(name, content='collages', content_rowid='id');

CREATE TABLE collage_releases (
  collage_id INTEGER NOT NULL,
  release_id INTEGER NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  added_on TEXT,
  PRIMARY KEY (collage_id, release_id)
);
CREATE INDEX idx_collage_releases_release ON collage_releases(release_id);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  tag_type TEXT NOT NULL DEFAULT 'other',
  uses INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_tags_name ON tags(name);
CREATE INDEX idx_tags_uses ON tags(uses);
CREATE VIRTUAL TABLE tags_fts USING fts5(name, content='tags', content_rowid='id');

CREATE TABLE release_tags (
  release_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  positive_votes INTEGER NOT NULL DEFAULT 1,
  negative_votes INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (release_id, tag_id)
);
CREATE INDEX idx_release_tags_tag ON release_tags(tag_id);

CREATE TABLE torrents (
  id INTEGER PRIMARY KEY,
  release_id INTEGER NOT NULL,
  media TEXT,
  format TEXT,
  encoding TEXT,
  remastered INTEGER NOT NULL DEFAULT 0,
  remaster_year INTEGER,
  remaster_title TEXT,
  remaster_catalogue_number TEXT,
  remaster_record_label TEXT,
  scene INTEGER NOT NULL DEFAULT 0,
  has_log INTEGER NOT NULL DEFAULT 0,
  has_cue INTEGER NOT NULL DEFAULT 0,
  log_score INTEGER NOT NULL DEFAULT 0,
  file_list TEXT,
  file_path TEXT,
  size INTEGER,
  time TEXT
);
CREATE INDEX idx_torrents_release ON torrents(release_id);

CREATE TABLE artists_similar (
  artist_id INTEGER NOT NULL,
  similar_id INTEGER NOT NULL,
  PRIMARY KEY (artist_id, similar_id)
);

CREATE TABLE artists_similar_scores (
  similar_id INTEGER PRIMARY KEY,
  score INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE wiki_articles (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  date TEXT,
  body_html TEXT NOT NULL
);
CREATE INDEX idx_wiki_articles_title ON wiki_articles(title);

-- Cover art lookups are cached, not re-fetched -- a row existing means
-- "already looked up" even when cover_url is NULL (nothing found), so we
-- don't hit MusicBrainz/iTunes/Discogs again for the same release.
CREATE TABLE release_covers (
  release_id INTEGER PRIMARY KEY,
  cover_url TEXT,
  source TEXT,
  fetched_at TEXT NOT NULL
);

-- Same caching approach as release_covers, for the best-effort artist
-- photo/bio substitute (see api/src/artistInfo.ts).
CREATE TABLE artist_info (
  artist_id INTEGER PRIMARY KEY,
  bio TEXT,
  image_url TEXT,
  source TEXT,
  fetched_at TEXT NOT NULL
);
