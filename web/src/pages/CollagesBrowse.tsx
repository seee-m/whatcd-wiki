import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type CollageList } from '../lib/api';
import { Box } from '../components/Box';
import { Pagination } from '../components/Pagination';

export function CollagesBrowse() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<CollageList | null>(null);
  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'name_asc';

  useEffect(() => {
    api.collages(params).then(setData);
  }, [params]);

  function update(next: Record<string, string | null>) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') p.delete(k);
      else p.set(k, v);
    }
    if (!('page' in next)) p.delete('page');
    setParams(p);
  }

  return (
    <>
      <Box title="Collages">
        <p className="center">
          <input
            type="text"
            defaultValue={q}
            placeholder="Search collages&hellip;"
            onKeyDown={(e) => {
              if (e.key === 'Enter') update({ q: (e.target as HTMLInputElement).value });
            }}
          />{' '}
          <select value={sort} onChange={(e) => update({ sort: e.target.value })}>
            <option value="name_asc">Name A-Z</option>
            <option value="name_desc">Name Z-A</option>
          </select>
        </p>
      </Box>
      {data && (
        <>
          <table className="torrent_table">
            <tbody>
              <tr className="colhead">
                <td>Name</td>
                <td>Category</td>
                <td># Torrents</td>
              </tr>
              {data.items.map((c) => (
                <tr className="group" key={c.id}>
                  <td>
                    <Link to={`/collages/${c.id}`}>{c.name}</Link>
                  </td>
                  <td>{c.categoryName}</td>
                  <td>{c.numTorrents}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => update({ page: String(p) })} />
        </>
      )}
    </>
  );
}
