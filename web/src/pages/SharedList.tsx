import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type SharedList as SharedListData } from '../lib/api';
import { Box } from '../components/Box';

export function SharedList() {
  const { id } = useParams();
  const [list, setList] = useState<SharedListData | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!id) return;
    setList(null);
    setNotFound(false);
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
        </div>
      </div>
    </>
  );
}
