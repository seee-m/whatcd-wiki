import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type ArtistRef } from '../lib/api';
import { Box } from '../components/Box';

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
    setLoading(true);
    api
      .artistSearch(q)
      .then((r) => setResults(r.items))
      .finally(() => setLoading(false));
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
