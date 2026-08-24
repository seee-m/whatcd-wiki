import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type TagListItem } from '../lib/api';
import { Box } from '../components/Box';
import { Pagination } from '../components/Pagination';

export function Tags() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<{ page: number; pageSize: number; total: number; items: TagListItem[] } | null>(
    null,
  );
  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'name_asc';

  useEffect(() => {
    api.tags(params).then(setData);
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
      <Box title="Tags">
        <p className="center">
          <input
            type="text"
            defaultValue={q}
            placeholder="Search tags&hellip;"
            onKeyDown={(e) => {
              if (e.key === 'Enter') update({ q: (e.target as HTMLInputElement).value });
            }}
          />{' '}
          <select value={sort} onChange={(e) => update({ sort: e.target.value })}>
            <option value="name_asc">Name A-Z</option>
            <option value="name_desc">Name Z-A</option>
            <option value="uses">Most used</option>
          </select>
        </p>
      </Box>
      {data && (
        <>
          <div className="tags" style={{ padding: '10px', fontSize: '1.1em' }}>
            {data.items.map((t) => (
              <Link key={t.id} to={`/torrents?tag=${t.id}`}>
                {t.name} ({t.uses})
              </Link>
            ))}
          </div>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => update({ page: String(p) })} />
        </>
      )}
    </>
  );
}
