import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type ReleaseList } from '../lib/api';
import { Box } from '../components/Box';
import { Pagination } from '../components/Pagination';
import { RELEASE_TYPES } from '../lib/releaseTypes';

const CATEGORIES = [
  { id: 1, name: 'Music', icon: 'music.png' },
  { id: 2, name: 'Applications', icon: 'apps.png' },
  { id: 3, name: 'E-Books', icon: 'ebook.png' },
  { id: 4, name: 'Audiobooks', icon: 'audiobook.png' },
  { id: 5, name: 'E-Learning Videos', icon: 'elearning.png' },
  { id: 6, name: 'Comedy', icon: 'comedy.png' },
  { id: 7, name: 'Comics', icon: 'comics.png' },
];

const icons = import.meta.glob('../assets/caticons/*.png', { eager: true, import: 'default' }) as Record<
  string,
  string
>;
function iconSrc(file: string): string {
  const key = Object.keys(icons).find((k) => k.endsWith('/' + file));
  return key ? icons[key] : '';
}

export function TorrentsBrowse() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<ReleaseList | null>(null);
  const [loading, setLoading] = useState(true);

  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'name_asc';
  const selectedCats = new Set((params.get('category') ?? '').split(',').filter(Boolean).map(Number));
  const type = params.get('type') ?? '';
  const page = Number(params.get('page') ?? '1');

  useEffect(() => {
    setLoading(true);
    api
      .torrents(params)
      .then(setData)
      .finally(() => setLoading(false));
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

  function toggleCategory(id: number) {
    const next = new Set(selectedCats);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    update({ category: [...next].join(',') || null });
  }

  return (
    <>
      {data?.activeTag && (
        <h2>
          Tag: {data.activeTag.name}{' '}
          <a
            href="#"
            className="clear-filter"
            onClick={(e) => {
              e.preventDefault();
              update({ tag: null });
            }}
          >
            (clear)
          </a>
        </h2>
      )}
      <Box title="Torrents">
        <form
          className="filter_torrents"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            update({ q: String(form.get('q') ?? '') });
          }}
        >
          <table className="cat_list">
            <tbody>
              <tr>
                {CATEGORIES.map((c) => (
                  <td key={c.id}>
                    <label>
                      <input type="checkbox" checked={selectedCats.has(c.id)} onChange={() => toggleCategory(c.id)} />
                      <img src={iconSrc(c.icon)} alt="" className="cat-icon" />
                      {c.name}
                    </label>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
          <p className="center">
            <input type="text" name="q" defaultValue={q} placeholder="Search releases&hellip;" />{' '}
            <select value={type} onChange={(e) => update({ type: e.target.value || null })}>
              <option value="">All types</option>
              {RELEASE_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>{' '}
            <select value={sort} onChange={(e) => update({ sort: e.target.value })}>
              <option value="name_asc">Name A-Z</option>
              <option value="name_desc">Name Z-A</option>
              <option value="year_asc">Year (oldest first)</option>
              <option value="year_desc">Year (newest first)</option>
            </select>{' '}
            <input type="submit" value="Search" />
          </p>
        </form>
      </Box>

      {loading && <p className="center">Loading&hellip;</p>}

      {data && (
        <>
          <table className="torrent_table">
            <tbody>
              <tr className="colhead">
                <td>Name</td>
                <td>Type</td>
                <td>Year</td>
              </tr>
              {data.items.map((r) => (
                <tr key={r.id} className="group">
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
                  <td>{r.releaseType}</td>
                  <td>{r.year ?? '—'}</td>
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
