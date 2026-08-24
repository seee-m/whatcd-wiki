import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type WikiIndexItem } from '../lib/api';
import { Box } from '../components/Box';

export function Wiki() {
  const [items, setItems] = useState<WikiIndexItem[]>([]);

  useEffect(() => {
    api.wikiIndex().then((r) => setItems(r.items));
  }, []);

  return (
    <Box title={`Wiki (${items.length} articles)`}>
      <ul className="wiki-index-list nobullet">
        {items.map((a) => (
          <li key={a.id}>
            <Link to={`/wiki/${a.id}`}>{a.title}</Link>
          </li>
        ))}
      </ul>
    </Box>
  );
}
