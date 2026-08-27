import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type ReleaseDetail, type TorrentEdition, type ReleaseExtras } from '../lib/api';
import { Box } from '../components/Box';
import { DiscogsVideoBox } from '../components/DiscogsVideoBox';
import { parseFileList, formatBytes } from '../lib/fileList';
import { addToDraft, removeFromDraft, isInDraft } from '../lib/listDraft';

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

// File lists are no longer part of the release payload (they were 58% of
// the entire database and pushed one release's response to 3.7MB), so the
// entry count isn't known until a visitor actually opens a toggle -- hence
// the bare "View file list" until it loads. Every torrent in the archive
// has a non-empty file list (checked: 0 of 2,678,446 are empty), so the
// toggle always belongs there, exactly as the old `files.length > 0` gate
// always resolved true.
function EditionGroup({
  label,
  editions,
  fileLists,
  onOpenFileList,
}: {
  label: string;
  editions: TorrentEdition[];
  fileLists: Record<number, string> | null;
  onOpenFileList: () => void;
}) {
  return (
    <>
      <tr className="colhead_dark">
        <td colSpan={4}>&minus; {label}</td>
      </tr>
      {editions.map((t) => {
        const raw = fileLists?.[t.id];
        const files = raw === undefined ? null : parseFileList(raw);
        return (
          <tr className="group_torrent" key={t.id}>
            <td>
              &raquo; {t.format} / {t.encoding}
              {t.has_log ? ` / Log (${t.log_score}%)` : ''}
              {t.has_cue ? ' / Cue' : ''}
              <details onToggle={(e) => e.currentTarget.open && onOpenFileList()}>
                <summary>View file list{files ? ` (${files.length})` : ''}</summary>
                {files === null ? (
                  <p>Loading&hellip;</p>
                ) : (
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
                )}
              </details>
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
  const [coverSource, setCoverSource] = useState<string | null>(null);
  const [extras, setExtras] = useState<ReleaseExtras | null>(null);
  const [refreshingExtras, setRefreshingExtras] = useState(false);
  const [activeVideo, setActiveVideo] = useState(0);
  const [videoClicked, setVideoClicked] = useState(false);
  const [inDraft, setInDraft] = useState(false);
  // One request covers every edition of the release, so opening a second
  // toggle costs nothing. Kept as null until the first toggle is opened.
  const [fileLists, setFileLists] = useState<Record<number, string> | null>(null);
  const fileListsRequested = useRef(false);

  useEffect(() => {
    if (!id) return;
    setCoverUrl(null);
    setCoverSource(null);
    setExtras(null);
    setActiveVideo(0);
    setVideoClicked(false);
    setFileLists(null);
    fileListsRequested.current = false;
    api.torrent(id).then((r) => {
      setRelease(r);
      setInDraft(isInDraft(r.id));
    });
    // Lazy, cached-on-first-view lookups, music releases only (see
    // routes/torrents.ts) -- failures/non-music just leave no result.
    api
      .torrentCover(id)
      .then((r) => {
        setCoverUrl(r.url);
        setCoverSource(r.source ?? null);
      })
      .catch(() => {});
    api
      .torrentExtras(id)
      .then(setExtras)
      .catch(() => {});
  }, [id]);

  function loadFileLists() {
    if (fileListsRequested.current || !id) return;
    fileListsRequested.current = true;
    api
      .torrentFiles(id)
      .then((r) => setFileLists(r.files))
      .catch(() => {
        // Let a later toggle retry rather than leaving it stuck on "Loading…".
        fileListsRequested.current = false;
      });
  }

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
        {extras && (extras.videos.length > 0 || extras.discogsUrl) && (
          <DiscogsVideoBox
            videos={extras.videos.map((v) => ({ key: v.url, label: v.title, title: v.title, url: v.url }))}
            activeVideo={activeVideo}
            videoClicked={videoClicked}
            viewReleaseUrl={extras.discogsUrl}
            onSelect={(i) => {
              setActiveVideo(i);
              setVideoClicked(true);
            }}
            refreshing={refreshingExtras}
            onRefresh={() => {
              if (!id) return;
              setRefreshingExtras(true);
              api
                .torrentExtrasRefresh(id)
                .then((r) => {
                  setExtras(r);
                  // The backend clears a Discogs-sourced cover the moment
                  // it can't verify a real match for this release (same
                  // blind-search flaw, see routes/torrents.ts) -- pull the
                  // corrected value so it updates here too, not just on a
                  // later page load.
                  if (!r.discogsUrl && coverSource === 'discogs') {
                    api
                      .torrentCover(id)
                      .then((c) => {
                        setCoverUrl(c.url);
                        setCoverSource(c.source ?? null);
                      })
                      .catch(() => {});
                  }
                })
                .finally(() => setRefreshingExtras(false));
            }}
          />
        )}
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
                <EditionGroup
                  key={key}
                  label={editionLabel(editions[0])}
                  editions={editions}
                  fileLists={fileLists}
                  onOpenFileList={loadFileLists}
                />
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
        {(coverUrl || (extras && (extras.videos.length > 0 || extras.discogsUrl))) && (
          <p className="external-disclaimer">
            {coverUrl && (
              <>
                Cover art via {coverSource === 'musicbrainz' ? 'MusicBrainz' : coverSource === 'itunes' ? 'iTunes' : 'Discogs'}.{' '}
              </>
            )}
            {extras && (extras.videos.length > 0 || extras.discogsUrl) && <>Videos/release link via Discogs. </>}
            Not part of the original archive, may be inaccurate.
          </p>
        )}
        <p className="action-row">
          <button
            type="button"
            className="dice-button auto-width-button"
            onClick={() => {
              if (inDraft) {
                removeFromDraft(release.id);
              } else {
                addToDraft({ id: release.id, name: release.name, year: release.year, artists: release.artists });
              }
              setInDraft(!inDraft);
            }}
          >
            {inDraft ? 'Remove from list' : 'Add to list'}
          </button>
        </p>
      </div>
      </div>
    </>
  );
}
