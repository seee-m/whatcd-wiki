import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type ArtistRef } from '../lib/api';
import { Box } from '../components/Box';

const SEARCH_DEBOUNCE_MS = 250;

export function ArtistSearch() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [results, setResults] = useState<ArtistRef[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    // The input drives the URL on every keystroke, so without this each
    // one costs an FTS query on the single-threaded server.
    setLoading(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .artistSearch(q)
        .then((r) => {
          if (!cancelled) setResults(r.items);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  return (
    <Box title="Artists">
      <p className="center">
        <input
          type="text"
          value={q}
          placeholder="Search artists&hellip; (min 2 characters)"
          onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {})}
          autoFocus
        />
      </p>
      {loading && <p className="center">Searching&hellip;</p>}
      {!loading && q.trim().length >= 2 && results.length === 0 && <p className="center">No artists found.</p>}
      <ul className="nobullet">
        {results.map((a) => (
          <li key={a.id}>
            <Link to={`/artists/${a.id}`}>{a.name}</Link>
          </li>
        ))}
      </ul>
    </Box>
  );
}
