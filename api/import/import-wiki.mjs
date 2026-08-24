// One-time ETL: whatcd-goodbye/wikis/*.txt -> data/whatcd.sqlite (wiki_articles).
// No MariaDB involved — these files are `mysql \G` vertical output, one row
// (one article) per file, not mysqldump SQL. Field lines are right-padded to
// a fixed width of 12 chars before the colon (mysql's own formatting), e.g.
//   "          ID: 136"
//   "MinClassRead: 100"
//   "        Body: [align=center]...   <- continues across following lines
// Only lines matching that exact 12-char-label pattern for one of the known
// non-Body field names start a new field; everything else is treated as a
// continuation of the current field's value (this is how Body's multi-line
// content survives without being mistaken for new fields).
//
// Usage: node api/import/import-wiki.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { bbcodeToHtml } from './bbcode.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH =
  process.env.SQLITE_PATH || path.join(os.homedir(), 'Library/Application Support/whatcd-wiki/whatcd.sqlite');
const WIKI_DIR = path.join(__dirname, '../../whatcd-goodbye/wikis');

const FIELD_NAMES = ['ID', 'MinClassRead', 'MinClassEdit', 'Date', 'Title', 'Body'];
const FIELD_LINE = /^(.{12}): (.*)$/;
const ROW_SEPARATOR = /^\*+ \d+\. row \*+$/;

function parseWikiFile(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const fields = { ID: '', MinClassRead: '', MinClassEdit: '', Date: '', Title: '', Body: '' };
  let current = null;

  for (const line of lines) {
    if (ROW_SEPARATOR.test(line)) continue;
    // Body is always the last field, so once we're in it, every remaining
    // line is body content — never re-checked against the field pattern
    // (which would otherwise wrongly truncate articles whose text happens
    // to contain a line shaped like "        Date: ...").
    if (current !== 'Body') {
      const m = line.match(FIELD_LINE);
      if (m && FIELD_NAMES.includes(m[1].trim())) {
        current = m[1].trim();
        fields[current] = m[2];
        continue;
      }
      if (current === null) continue; // stray content before the first field
      fields[current] += (fields[current] ? '\n' : '') + line;
    } else {
      fields.Body += '\n' + line;
    }
  }

  return fields;
}

function main() {
  const dbExists = fs.existsSync(DB_PATH);
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const sqlite = new DatabaseSync(DB_PATH);
  if (!dbExists) {
    sqlite.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  }

  sqlite.exec('DELETE FROM wiki_articles');
  const insert = sqlite.prepare(
    'INSERT OR REPLACE INTO wiki_articles (id, title, date, body_html) VALUES (@id, @title, @date, @body_html)',
  );

  const files = fs.readdirSync(WIKI_DIR).filter((f) => f.endsWith('.txt') && f !== 'README.txt');
  const insertAll = (rows) => {
    sqlite.exec('BEGIN');
    try {
      for (const row of rows) insert.run(row);
      sqlite.exec('COMMIT');
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }
  };

  const rows = [];
  let skipped = 0;
  for (const file of files) {
    const text = fs.readFileSync(path.join(WIKI_DIR, file), 'utf8');
    const fields = parseWikiFile(text);
    const id = Number(fields.ID);
    if (!id || !fields.Title) {
      console.warn(`skipping unparseable file: ${file}`);
      skipped++;
      continue;
    }
    rows.push({
      id,
      title: fields.Title.trim(),
      date: fields.Date.trim() || null,
      body_html: bbcodeToHtml(fields.Body),
    });
  }

  insertAll(rows);
  console.log(`wiki_articles: ${rows.length} rows (${skipped} skipped) from ${files.length} files`);
  sqlite.close();
}

main();
