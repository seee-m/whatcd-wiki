import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type CollageDetail } from '../lib/api';
import { Box } from '../components/Box';
import noArt from '../assets/collage-noart.png';

const COVER_GRID_SIZE = 16;

export function Collage() {
  const { id } = useParams();
  const [collage, setCollage] = useState<CollageDetail | null>(null);
  const [covers, setCovers] = useState<Record<number, string | null>>({});

  useEffect(() => {
    if (!id) return;
    setCollage(null);
    setCovers({});
    api.collage(id).then((c) => {
      setCollage(c);
      // Lazy, cached-on-first-view per release (see api/src/cover.ts) --
      // fired individually rather than awaited as a batch so thumbnails
      // fill in as each one resolves instead of all-or-nothing.
      for (const r of c.releases.slice(0, COVER_GRID_SIZE)) {
        api
          .torrentCover(r.id)
          .then((res) => setCovers((prev) => ({ ...prev, [r.id]: res.url })))
          .catch(() => {});
      }
    });
  }, [id]);

  if (!collage) return <p className="center">Loading&hellip;</p>;

  return (
    <>
      <h2>{collage.name}</h2>

      <div className="detail-columns">
        <div className="sidebar">
          <Box title="Category">{collage.categoryName}</Box>
          {collage.tags.length > 0 && (
            <Box title="Tags">
              <div className="tags">
                {collage.tags.map((t) =>
                  t.id ? (
                    <Link key={t.name} to={`/torrents?tag=${t.id}`}>
                      {t.name}
                    </Link>
                  ) : (
                    <span key={t.name}>{t.name}</span>
                  ),
                )}
              </div>
            </Box>
          )}
          <Box title="Statistics">
            <table className="noborder kv-table">
              <tbody>
                <tr>
                  <td className="label">Torrents:</td>
                  <td>{collage.numTorrents}</td>
                </tr>
                <tr>
                  <td className="label">Artists:</td>
                  <td>{collage.artistCount}</td>
                </tr>
                <tr>
                  <td className="label">Subscribers:</td>
                  <td>{collage.subscribers}</td>
                </tr>
                {collage.updated && (
                  <tr>
                    <td className="label">Last updated:</td>
                    <td>{new Date(collage.updated).toLocaleDateString()}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </Box>
        </div>

        <div className="main_column">
          <Box title="Cover Art">
            <div className="cover-grid">
              {collage.releases.slice(0, COVER_GRID_SIZE).map((r) => {
                const fetched = r.id in covers;
                const url = covers[r.id];
                if (!fetched) {
                  // Still waiting on the lazy per-release lookup.
                  return <Link key={r.id} to={`/torrents/${r.id}`} title={r.name} className="cover-grid-empty" />;
                }
                return (
                  <Link key={r.id} to={`/torrents/${r.id}`} title={r.name}>
                    <img src={url ?? noArt} alt={r.name} />
                  </Link>
                );
              })}
            </div>
          </Box>

          <Box title={`${collage.releases.length} releases`}>
            <table className="torrent_table">
              <tbody>
                {collage.releases.map((r) => (
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
        </div>
      </div>
    </>
  );
}
