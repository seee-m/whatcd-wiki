import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type ArtistDetail, type ArtistInfo } from '../lib/api';
import { Box } from '../components/Box';

export function Artist() {
  const { id } = useParams();
  const [artist, setArtist] = useState<ArtistDetail | null>(null);
  const [info, setInfo] = useState<ArtistInfo | null>(null);

  useEffect(() => {
    if (!id) return;
    setArtist(null);
    setInfo(null);
    api.artist(id).then(setArtist);
    // Best-effort substitute for the site's own editor-curated artist
    // image/bio, which lived in a `wiki_artists` table this dump doesn't
    // include -- see api/src/artistInfo.ts. Not restored data.
    api
      .artistInfo(id)
      .then(setInfo)
      .catch(() => {});
  }, [id]);

  if (!artist) return <p className="center">Loading&hellip;</p>;

  const groupNames = Object.keys(artist.discography).sort();
  const hasSidebar = artist.aliases.length > 0 || artist.similarArtists.length > 0 || info?.image || info?.bio;

  return (
    <>
      <h2>{artist.name}</h2>

      <div className="detail-columns">
        {hasSidebar && (
          <div className="sidebar">
            {(info?.image || info?.bio) && (
              <Box title={artist.name}>
                {info.image && <img src={info.image} alt={artist.name} style={{ width: '100%' }} />}
                {info.bio && <p>{info.bio}</p>}
                <p className="external-disclaimer">
                  via {info.source === 'wikipedia' ? 'Wikipedia' : 'Discogs'} &mdash; not part of the original
                  archive, information may be inaccurate.
                </p>
              </Box>
            )}

            {artist.aliases.length > 0 && (
              <Box title="Also known as">
                <ul className="nobullet">
                  {artist.aliases.map((a) => (
                    <li key={a.id}>{a.name}</li>
                  ))}
                </ul>
              </Box>
            )}

            {artist.similarArtists.length > 0 && (
              <Box title="Similar Artists">
                <ul className="nobullet">
                  {artist.similarArtists.map((a) => (
                    <li key={a.id}>
                      <Link to={`/artists/${a.id}`}>{a.name}</Link>
                    </li>
                  ))}
                </ul>
              </Box>
            )}
          </div>
        )}

        <div className={hasSidebar ? 'main_column' : ''}>
          {groupNames.length === 0 && artist.appearsOn.length === 0 && (
            <Box title="Discography">
              <p>No releases found for this artist.</p>
            </Box>
          )}

          {groupNames.map((type) => (
            <div className="discog-group" key={type}>
              <h3>{type}</h3>
              <table className="torrent_table">
                <tbody>
                  {artist.discography[type]
                    .slice()
                    .sort((a, b) => (a.year ?? 0) - (b.year ?? 0))
                    .map((r) => (
                      <tr className="group" key={r.id}>
                        <td>{r.year ?? '—'}</td>
                        <td>
                          <Link to={`/torrents/${r.id}`}>{r.name}</Link>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ))}

          {artist.appearsOn.length > 0 && (
            <div className="discog-group">
              <h3>Guest appearances / other credits</h3>
              <table className="torrent_table">
                <tbody>
                  {artist.appearsOn.map((r) => (
                    <tr className="group" key={r.id}>
                      <td>{r.year ?? '—'}</td>
                      <td>
                        <Link to={`/torrents/${r.id}`}>{r.name}</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
