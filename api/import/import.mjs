// One-time ETL: MariaDB staging database (loaded from whatcd-goodbye/what_db/*.sql)
// -> whatcd.sqlite
//
// Why MariaDB as staging at all: the source files are real `mysqldump` output,
// including binary BLOB columns and escaped quotes inside multi-row INSERTs.
// Letting the real `mysql` client parse that (via `mysql whatcd < file.sql`)
// avoids hand-rolling a mysqldump parser for a one-time, high-stakes import.
//
// The output file defaults to ~/Library/Application Support/whatcd-wiki --
// deliberately outside this project's Dropbox-synced folder. A multi-GB
// SQLite file written here in WAL mode hit real SQLITE_BUSY errors from
// Dropbox's file watcher during development; build it locally (SQLITE_PATH
// can point anywhere, e.g. /private/tmp for a scratch build) then let it
// land in its final non-synced home.
//
// Usage:
//   brew install mariadb
//   brew services start mariadb
//   mysql -u root -e "CREATE DATABASE whatcd"
//   for f in whatcd-goodbye/what_db/*.sql; do mysql -u root whatcd < "$f"; done
//   node api/import/import.mjs

import mysql from 'mysql2';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH =
  process.env.SQLITE_PATH || path.join(os.homedir(), 'Library/Application Support/whatcd-wiki/whatcd.sqlite');

const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'whatcd',
};

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.rmSync(DB_PATH, { force: true });
fs.rmSync(DB_PATH + '-wal', { force: true });
fs.rmSync(DB_PATH + '-shm', { force: true });

const sqlite = new DatabaseSync(DB_PATH);
sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA synchronous = OFF');
sqlite.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

const conn = mysql.createConnection(MYSQL_CONFIG);

function toIso(d) {
  if (d == null) return null;
  if (d instanceof Date) {
    // MySQL's zero-date ('0000-00-00 00:00:00') surfaces as an invalid Date
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  return String(d);
}

/** Streams `sql` from MySQL and calls `insertBatch(rows)` every `batchSize` rows. */
function streamTable(sql, batchSize, insertBatch) {
  return new Promise((resolve, reject) => {
    let batch = [];
    let count = 0;
    const stream = conn.query(sql).stream({ highWaterMark: 5000 });
    stream.on('data', (row) => {
      batch.push(row);
      if (batch.length >= batchSize) {
        const toInsert = batch;
        batch = [];
        insertBatch(toInsert);
        count += toInsert.length;
      }
    });
    stream.on('end', () => {
      if (batch.length) {
        insertBatch(batch);
        count += batch.length;
      }
      resolve(count);
    });
    stream.on('error', reject);
  });
}

async function importTable({ label, sql, insertSql, mapRow, batchSize = 5000 }) {
  const stmt = sqlite.prepare(insertSql);
  const insertMany = (rows) => {
    sqlite.exec('BEGIN');
    try {
      for (const row of rows) stmt.run(mapRow(row));
      sqlite.exec('COMMIT');
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }
  };
  process.stdout.write(`${label}: `);
  const start = Date.now();
  const count = await streamTable(sql, batchSize, insertMany);
  console.log(`${count} rows (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  return count;
}

async function main() {
  await importTable({
    label: 'artists',
    sql: 'SELECT ArtistID, Name FROM artists_group',
    insertSql: 'INSERT INTO artists (id, name) VALUES (@id, @name)',
    mapRow: (r) => ({ id: r.ArtistID, name: r.Name ?? '' }),
  });

  await importTable({
    label: 'artist_aliases',
    sql: 'SELECT AliasID, ArtistID, Name, Redirect FROM artists_alias',
    insertSql:
      'INSERT INTO artist_aliases (id, artist_id, name, redirect) VALUES (@id, @artist_id, @name, @redirect)',
    mapRow: (r) => ({ id: r.AliasID, artist_id: r.ArtistID, name: r.Name ?? '', redirect: r.Redirect ?? 0 }),
  });

  await importTable({
    label: 'artists_similar',
    sql: 'SELECT ArtistID, SimilarID FROM artists_similar',
    insertSql: 'INSERT OR IGNORE INTO artists_similar (artist_id, similar_id) VALUES (@artist_id, @similar_id)',
    mapRow: (r) => ({ artist_id: r.ArtistID, similar_id: r.SimilarID }),
  });

  await importTable({
    label: 'artists_similar_scores',
    sql: 'SELECT SimilarID, Score FROM artists_similar_scores',
    insertSql: 'INSERT OR IGNORE INTO artists_similar_scores (similar_id, score) VALUES (@similar_id, @score)',
    mapRow: (r) => ({ similar_id: r.SimilarID, score: r.Score ?? 0 }),
  });

  await importTable({
    label: 'collages',
    sql: 'SELECT ID, Name, NumTorrents, CategoryID, TagList, Subscribers, updated FROM collages',
    insertSql:
      'INSERT INTO collages (id, name, num_torrents, category_id, tag_list, subscribers, updated) VALUES (@id, @name, @num_torrents, @category_id, @tag_list, @subscribers, @updated)',
    mapRow: (r) => ({
      id: r.ID,
      name: r.Name ?? '',
      num_torrents: r.NumTorrents ?? 0,
      category_id: r.CategoryID ?? 1,
      tag_list: r.TagList ?? '',
      subscribers: r.Subscribers ?? 0,
      updated: toIso(r.updated),
    }),
  });

  await importTable({
    label: 'collage_releases',
    sql: 'SELECT CollageID, GroupID, Sort, AddedOn FROM collages_torrents',
    insertSql:
      'INSERT OR IGNORE INTO collage_releases (collage_id, release_id, sort, added_on) VALUES (@collage_id, @release_id, @sort, @added_on)',
    mapRow: (r) => ({ collage_id: r.CollageID, release_id: r.GroupID, sort: r.Sort ?? 0, added_on: toIso(r.AddedOn) }),
  });

  await importTable({
    label: 'tags',
    sql: 'SELECT ID, Name, TagType, Uses FROM tags',
    insertSql: 'INSERT INTO tags (id, name, tag_type, uses) VALUES (@id, @name, @tag_type, @uses)',
    mapRow: (r) => ({ id: r.ID, name: r.Name ?? '', tag_type: r.TagType ?? 'other', uses: r.Uses ?? 1 }),
  });

  await importTable({
    label: 'release_tags',
    sql: 'SELECT TagID, GroupID, PositiveVotes, NegativeVotes FROM torrents_tags',
    insertSql:
      'INSERT OR IGNORE INTO release_tags (release_id, tag_id, positive_votes, negative_votes) VALUES (@release_id, @tag_id, @positive_votes, @negative_votes)',
    mapRow: (r) => ({
      release_id: r.GroupID,
      tag_id: r.TagID,
      positive_votes: r.PositiveVotes ?? 1,
      negative_votes: r.NegativeVotes ?? 1,
    }),
    batchSize: 10000,
  });

  await importTable({
    label: 'releases',
    sql: 'SELECT ID, CategoryID, Name, Year, CatalogueNumber, RecordLabel, ReleaseType, Time FROM torrents_group',
    insertSql:
      'INSERT INTO releases (id, category_id, name, year, catalogue_number, record_label, release_type, time) VALUES (@id, @category_id, @name, @year, @catalogue_number, @record_label, @release_type, @time)',
    mapRow: (r) => ({
      id: r.ID,
      category_id: r.CategoryID ?? 1,
      name: r.Name ?? '',
      year: r.Year ?? 0,
      catalogue_number: r.CatalogueNumber ?? '',
      record_label: r.RecordLabel ?? '',
      release_type: r.ReleaseType ?? 21,
      time: toIso(r.Time),
    }),
    batchSize: 10000,
  });

  await importTable({
    label: 'release_artists',
    sql: 'SELECT GroupID, ArtistID, AliasID, Importance FROM torrents_artists',
    insertSql:
      'INSERT OR IGNORE INTO release_artists (release_id, artist_id, alias_id, importance) VALUES (@release_id, @artist_id, @alias_id, @importance)',
    mapRow: (r) => ({
      release_id: r.GroupID,
      artist_id: r.ArtistID,
      alias_id: r.AliasID,
      importance: Number(r.Importance) || 1,
    }),
    batchSize: 10000,
  });

  // Largest table last.
  await importTable({
    label: 'torrents',
    sql: `SELECT ID, GroupID, Media, Format, Encoding, Remastered, RemasterYear, RemasterTitle,
                 RemasterCatalogueNumber, RemasterRecordLabel, Scene, HasLog, HasCue, LogScore,
                 FileList, FilePath, Size, Time
          FROM torrents`,
    insertSql: `INSERT INTO torrents
        (id, release_id, media, format, encoding, remastered, remaster_year, remaster_title,
         remaster_catalogue_number, remaster_record_label, scene, has_log, has_cue, log_score,
         file_list, file_path, size, time)
        VALUES
        (@id, @release_id, @media, @format, @encoding, @remastered, @remaster_year, @remaster_title,
         @remaster_catalogue_number, @remaster_record_label, @scene, @has_log, @has_cue, @log_score,
         @file_list, @file_path, @size, @time)`,
    mapRow: (r) => ({
      id: r.ID,
      release_id: r.GroupID,
      media: r.Media,
      format: r.Format,
      encoding: r.Encoding,
      remastered: Number(r.Remastered) || 0,
      remaster_year: r.RemasterYear,
      remaster_title: r.RemasterTitle ?? '',
      remaster_catalogue_number: r.RemasterCatalogueNumber ?? '',
      remaster_record_label: r.RemasterRecordLabel ?? '',
      scene: Number(r.Scene) || 0,
      has_log: Number(r.HasLog) || 0,
      has_cue: Number(r.HasCue) || 0,
      log_score: r.LogScore ?? 0,
      file_list: r.FileList ?? '',
      file_path: r.FilePath ?? '',
      size: r.Size ?? 0,
      time: toIso(r.Time),
    }),
    batchSize: 5000,
  });

  console.log('Populating full-text search indexes...');
  sqlite.exec(`
    INSERT INTO releases_fts(rowid, name) SELECT id, name FROM releases;
    INSERT INTO artists_fts(rowid, name) SELECT id, name FROM artists;
    INSERT INTO collages_fts(rowid, name) SELECT id, name FROM collages;
    INSERT INTO tags_fts(rowid, name) SELECT id, name FROM tags;
  `);

  console.log('Done. Running ANALYZE...');
  sqlite.exec('ANALYZE');
  sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  sqlite.exec('PRAGMA journal_mode = DELETE');
  sqlite.close();
  conn.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
