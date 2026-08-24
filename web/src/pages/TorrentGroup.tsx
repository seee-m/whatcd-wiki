import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type ReleaseDetail, type TorrentEdition } from '../lib/api';
import { Box } from '../components/Box';
import { parseFileList, formatBytes } from '../lib/fileList';

const noartworkModules = import.meta.glob('../assets/noartwork/*.png', { eager: true, import: 'default' }) as Record<
  string,
  string
>;
const NOARTWORK_BY_FILE: Record<string, string> = {};
for (const [path, src] of Object.entries(noartworkModules)) {
  NOARTWORK_BY_FILE[path.split('/').pop()!] = src;
}
const CATEGORY_ICON_FILE: Record<number, string> = {
  1: 'music.png',
  2: 'apps.png',
  3: 'ebook.png',
  4: 'audiobook.png',
  5: 'elearning.png',
  6: 'comedy.png',
  7: 'comics.png',
};

function editionKey(t: TorrentEdition): string {
  return t.remastered
    ? `${t.remaster_year ?? ''}|${t.remaster_title ?? ''}|${t.remaster_catalogue_number ?? ''}|${t.remaster_record_label ?? ''}|${t.media}`
    : `original|${t.media}`;
}

function editionLabel(t: TorrentEdition): string {
  if (!t.remastered) return `Original Release / ${t.media ?? 'Unknown'}`;
  const bits = [t.remaster_year, t.remaster_title].filter(Boolean);
  return `${bits.join(' ') || 'Remastered'} / ${t.media ?? 'Unknown'}`;
}

function EditionGroup({ label, editions }: { label: string; editions: TorrentEdition[] }) {
  return (
    <>
      <tr className="colhead_dark">
        <td colSpan={4}>&minus; {label}</td>
      </tr>
      {editions.map((t) => {
        const files = parseFileList(t.file_list);
        return (
          <tr className="group_torrent" key={t.id}>
            <td>
              &raquo; {t.format} / {t.encoding}
              {t.has_log ? ` / Log (${t.log_score}%)` : ''}
              {t.has_cue ? ' / Cue' : ''}
              {files.length > 0 && (
                <details>
                  <summary>View file list ({files.length})</summary>
                  <table className="noborder file-list-table">
                    <tbody>
                      {files.map((f, i) => (
                        <tr key={i}>
                          <td>{f.name}</td>
                          <td>{formatBytes(f.size)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </td>
            <td className="center">{formatBytes(t.size)}</td>
          </tr>
        );
      })}
    </>
  );
}

export function TorrentGroup() {
  const { id } = useParams();
  const [release, setRelease] = useState<ReleaseDetail | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setCoverUrl(null);
    api.torrent(id).then(setRelease);
    // Lazy, cached-on-first-view lookup (MusicBrainz -> iTunes -> Discogs)
    // -- see api/src/cover.ts. Failures just leave the category placeholder.
    api
      .torrentCover(id)
      .then((r) => setCoverUrl(r.url))
      .catch(() => {});
  }, [id]);

  if (!release) return <p className="center">Loading&hellip;</p>;

  const groups = new Map<string, TorrentEdition[]>();
  for (const t of release.editions) {
    const key = editionKey(t);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
  }

  const coverFile = CATEGORY_ICON_FILE[release.categoryId] ?? 'music.png';

  return (
    <>
      <h2>
        {release.artists.length > 0 && (
          <>
            {release.artists.map((a, i) => (
              <span key={a.id}>
                {i > 0 && ', '}
                <Link to={`/artists/${a.id}`}>{a.name}</Link>
              </span>
            ))}
            {' - '}
          </>
        )}
        {release.name} [{release.year ?? 'Unknown'}] [{release.releaseType}]
      </h2>

      <div className="detail-columns">
      <div className="sidebar">
        <Box title="Cover">
          <img
            src={coverUrl ?? NOARTWORK_BY_FILE[coverFile]}
            alt=""
            style={{ width: '100%' }}
            onError={(e) => {
              // Fetched art can 404 (a stale cached URL, a provider outage) --
              // drop back to the category placeholder rather than a broken image.
              if (e.currentTarget.src !== NOARTWORK_BY_FILE[coverFile]) {
                e.currentTarget.src = NOARTWORK_BY_FILE[coverFile];
              }
            }}
          />
        </Box>
        <Box title="Artists">
          <ul className="nobullet">
            {release.artists.map((a) => (
              <li key={a.id}>
                <Link to={`/artists/${a.id}`}>{a.name}</Link>
              </li>
            ))}
          </ul>
        </Box>
        {release.collages.length > 0 && (
          <Box title={`In ${release.collages.length} collage${release.collages.length === 1 ? '' : 's'}`}>
            <ul className="nobullet">
              {release.collages.map((c) => (
                <li key={c.id}>
                  <Link to={`/collages/${c.id}`}>{c.name}</Link>
                </li>
              ))}
            </ul>
          </Box>
        )}
      </div>

      <div className="main_column">
        <Box title="Torrents">
          <table className="torrent_table">
            <tbody>
              {[...groups.entries()].map(([key, editions]) => (
                <EditionGroup key={key} label={editionLabel(editions[0])} editions={editions} />
              ))}
            </tbody>
          </table>
        </Box>

        <Box title="Release info">
          <table className="noborder kv-table">
            <tbody>
              <tr>
                <td className="label">Category:</td>
                <td>{release.categoryName}</td>
              </tr>
              {release.recordLabel && (
                <tr>
                  <td className="label">Record Label:</td>
                  <td>{release.recordLabel}</td>
                </tr>
              )}
              {release.catalogueNumber && (
                <tr>
                  <td className="label">Catalogue #:</td>
                  <td>{release.catalogueNumber}</td>
                </tr>
              )}
            </tbody>
          </table>
          {release.tags.length > 0 && (
            <div className="tags">
              {release.tags.map((t) => (
                <Link key={t.id} to={`/torrents?tag=${t.id}`}>
                  {t.name}
                </Link>
              ))}
            </div>
          )}
        </Box>
      </div>
      </div>
    </>
  );
}
