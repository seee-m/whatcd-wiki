import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type SharedList as SharedListData } from '../lib/api';
import { Box } from '../components/Box';
import { youtubeEmbedUrl } from '../lib/youtube';

const CSV_COLUMNS = ['Release', 'Artist', 'Label', 'Catalogue Number', 'Year', 'URL'];

// Wraps every field in quotes and doubles any embedded quote, per RFC 4180
// -- release/label names routinely contain commas, so bare comma-joining
// would silently corrupt the file.
function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function csvFromList(list: SharedListData): string {
  const rows = list.releases.map((r) =>
    [
      r.name,
      r.artists.map((a) => a.name).join('; '),
      r.recordLabel ?? '',
      r.catalogueNumber ?? '',
      r.year != null ? String(r.year) : '',
      `${window.location.origin}/torrents/${r.id}`,
    ]
      .map(csvField)
      .join(','),
  );
  return [CSV_COLUMNS.map(csvField).join(','), ...rows].join('\r\n');
}

function downloadCsv(list: SharedListData) {
  const slug = list.title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const blob = new Blob([csvFromList(list)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `whatcd-wiki-list-${slug || list.id}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function SharedList() {
  const { id } = useParams();
  const [list, setList] = useState<SharedListData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [copied, setCopied] = useState(false);
  const [activeVideo, setActiveVideo] = useState(0);
  const [videoClicked, setVideoClicked] = useState(false);

  useEffect(() => {
    if (!id) return;
    setList(null);
    setNotFound(false);
    setActiveVideo(0);
    setVideoClicked(false);
    api.list(id).catch(() => {
      setNotFound(true);
      return null;
    }).then((data) => {
      if (data) setList(data);
    });
  }, [id]);

  if (notFound) return <p className="center">List not found &mdash; the link may be wrong or the list was never created.</p>;
  if (!list) return <p className="center">Loading&hellip;</p>;

  return (
    <>
      <h2>{list.title}</h2>

      <div className="detail-columns">
        <div className="sidebar">
          <Box title="Category">{list.categoryName}</Box>
          {list.description && <Box title="Description">{list.description}</Box>}
          <Box title="Statistics">
            <table className="noborder kv-table">
              <tbody>
                <tr>
                  <td className="label">Releases:</td>
                  <td>{list.releases.length}</td>
                </tr>
                <tr>
                  <td className="label">Created:</td>
                  <td>{new Date(list.createdAt).toLocaleDateString()}</td>
                </tr>
              </tbody>
            </table>
          </Box>
        </div>

        <div className="main_column">
          <Box title={`${list.releases.length} releases`}>
            <table className="torrent_table">
              <tbody>
                {list.releases.map((r) => (
                  <tr className="group" key={r.id}>
                    <td>
                      {r.artists.length > 0 && (
                        <>
                          {r.artists.map((a, i) => (
                            <span key={a.id}>
                              {i > 0 && ', '}
                              <Link to={`/artists/${a.id}`}>{a.name}</Link>
                            </span>
                          ))}
                          {' – '}
                        </>
                      )}
                      <Link to={`/torrents/${r.id}`}>{r.name}</Link>
                    </td>
                    <td>{r.year ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Box>
          {list.discogsVideos.length > 0 &&
            (() => {
              const current = list.discogsVideos[activeVideo];
              const embedUrl = current && youtubeEmbedUrl(current.url, videoClicked);
              return (
                <Box
                  title={
                    <>
                      Youtube <span className="box-title-note">(Matching links via Discogs, may be inaccurate or incomplete)</span>
                    </>
                  }
                >
                  {embedUrl && (
                    <div className="video-embed">
                      <iframe
                        src={embedUrl}
                        title={current.title}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                      />
                    </div>
                  )}
                  <ul className="video-switcher">
                    {list.discogsVideos.map((v, i) => (
                      <li key={`${v.releaseId}-${v.url}`} className={i === activeVideo ? 'active' : undefined}>
                        <a
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setActiveVideo(i);
                            setVideoClicked(true);
                          }}
                        >
                          {v.artistNames.length > 0 ? `${v.artistNames.join(', ')} – ${v.releaseName}` : v.releaseName}: {v.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </Box>
              );
            })()}
          <p className="action-row list-actions">
            <button
              type="button"
              className="dice-button auto-width-button"
              onClick={() => {
                navigator.clipboard.writeText(window.location.href).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
            >
              {copied ? 'Copied!' : 'Copy link'}
            </button>
            <button type="button" className="dice-button auto-width-button" onClick={() => downloadCsv(list)}>
              Export CSV
            </button>
          </p>
        </div>
      </div>
    </>
  );
}
